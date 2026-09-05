import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import {
  backlinksFor,
  buildAuthoredGraph,
  db,
  makeUniqueTitle,
  parseMarkdown,
  rewriteWikiLinkTarget,
  seedIfEmpty,
  type KnowledgeGraph,
  type NoteRecord
} from "./lib/core";
import { ingestFile, formatLocation } from "./lib/documents";
import { extractEntityCandidates, extractRelationCandidates, updateReviewStatus } from "./lib/entities";
import { createTransformersProvider, documentBlocks, hybridRetrieve, noteBlocks, type EmbeddingProvider, type RankedEvidence } from "./lib/hybrid";
import { knowledgeDb, type CanvasRecord, type DocumentBlockRecord, type EntityCandidateRecord, type RelationCandidateRecord, type SourceDocumentRecord, type TrashRecord } from "./lib/store";
import { generateWithWebLLM, verifyExtractive, type VerifiedAnswer } from "./lib/verify";
import { addCanvasNode, createCanvas, dailyNoteTitle, expandTemplate, moveCanvasNode } from "./lib/workspace";
import { createNotesSnapshot, moveNoteToTrash, restoreTrashedNote } from "./lib/recovery";
import { exportPortableWorkspace, restorePortableWorkspace, validatePortableWorkspace } from "./lib/portable";

type MainView = "workspace" | "documents" | "graph" | "review" | "evidence" | "canvas" | "library";
type NoteMode = "edit" | "preview";

const safePath = (title: string) => `${title.replace(/[\\/:*?\"<>|]/g, "-")}.md`;
const stamp = () => new Date().toISOString();

function download(name: string, content: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function StudioApp() {
  const [notes, setNotes] = useState<NoteRecord[]>([]);
  const [documents, setDocuments] = useState<SourceDocumentRecord[]>([]);
  const [blocks, setBlocks] = useState<DocumentBlockRecord[]>([]);
  const [entities, setEntities] = useState<EntityCandidateRecord[]>([]);
  const [relations, setRelations] = useState<RelationCandidateRecord[]>([]);
  const [canvases, setCanvases] = useState<CanvasRecord[]>([]);
  const [trash, setTrash] = useState<TrashRecord[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [view, setView] = useState<MainView>("workspace");
  const [mode, setMode] = useState<NoteMode>("edit");
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState("Local-first · no account · no required API key");
  const [question, setQuestion] = useState("How are Welcome and GraphRAG connected, and what evidence supports provenance?");
  const [evidence, setEvidence] = useState<RankedEvidence[]>([]);
  const [verified, setVerified] = useState<VerifiedAnswer>();
  const [semanticState, setSemanticState] = useState<"off" | "loading" | "ready" | "failed">("off");
  const [llmProgress, setLlmProgress] = useState("");
  const semanticProvider = useRef<EmbeddingProvider>();

  const refresh = async (preferId?: string) => {
    const [nextNotes, nextDocuments, nextBlocks, nextEntities, nextRelations, nextCanvases, nextTrash] = await Promise.all([
      db.notes.orderBy("updatedAt").reverse().toArray(),
      knowledgeDb.documents.orderBy("importedAt").reverse().toArray(),
      knowledgeDb.blocks.toArray(),
      knowledgeDb.entities.orderBy("updatedAt").reverse().toArray(),
      knowledgeDb.relations.orderBy("updatedAt").reverse().toArray(),
      knowledgeDb.canvases.orderBy("updatedAt").reverse().toArray(),
      knowledgeDb.trash.orderBy("deletedAt").reverse().toArray()
    ]);
    setNotes(nextNotes); setDocuments(nextDocuments); setBlocks(nextBlocks); setEntities(nextEntities); setRelations(nextRelations); setCanvases(nextCanvases); setTrash(nextTrash);
    setSelectedId((current) => preferId && nextNotes.some((note) => note.id === preferId) ? preferId : current && nextNotes.some((note) => note.id === current) ? current : nextNotes[0]?.id ?? "");
  };

  useEffect(() => { void seedIfEmpty().then(() => refresh()); }, []);

  const selected = notes.find((note) => note.id === selectedId);
  const authoredGraph = useMemo(() => buildAuthoredGraph(notes), [notes]);
  const sources = useMemo(() => [...noteBlocks(notes), ...documentBlocks(blocks)], [notes, blocks]);
  const filteredNotes = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase();
    return needle ? notes.filter((note) => `${note.title}\n${note.markdown}`.toLocaleLowerCase().includes(needle)) : notes;
  }, [notes, filter]);

  const createNote = async (requested = "Untitled", markdown?: string) => {
    const title = makeUniqueTitle(requested, notes);
    const id = crypto.randomUUID();
    const now = stamp();
    const note: NoteRecord = { id, title, path: safePath(title), markdown: markdown ?? `# ${title}\n\nStart writing. Connect knowledge with [[Note Title]].`, createdAt: now, updatedAt: now };
    await db.notes.add(note); await refresh(id); setView("workspace"); setMode("edit");
  };

  const createDaily = async () => {
    const title = dailyNoteTitle(new Date());
    const existing = notes.find((note) => note.title === title);
    if (existing) { setSelectedId(existing.id); setView("workspace"); return; }
    const body = expandTemplate("---\ntype: daily\ndate: {{date}}\n---\n# {{title}}\n\n## Focus\n\n## Notes\n\n## Evidence captured\n", new Date(), { title });
    await createNote(title, body);
  };

  const saveSelected = async (markdown: string) => {
    if (!selected) return;
    const next = { ...selected, markdown, updatedAt: stamp() };
    setNotes((current) => current.map((note) => note.id === next.id ? next : note));
    await db.notes.put(next);
  };

  const renameSelected = async () => {
    if (!selected) return;
    const desired = prompt("Rename note", selected.title)?.trim();
    if (!desired || desired === selected.title) return;
    const title = makeUniqueTitle(desired, notes, selected.id);
    const now = stamp();
    const renamed: NoteRecord = { ...selected, title, path: safePath(title), markdown: selected.markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() === selected.title ? selected.markdown.replace(/^#\s+(.+)$/m, `# ${title}`) : selected.markdown, updatedAt: now };
    const next = notes.map((note) => {
      const base = note.id === selected.id ? renamed : note;
      const rewritten = rewriteWikiLinkTarget(base.markdown, selected.title, title);
      return rewritten === base.markdown ? base : { ...base, markdown: rewritten, updatedAt: now };
    });
    await db.transaction("rw", db.notes, async () => db.notes.bulkPut(next));
    await refresh(selected.id);
    setStatus(`Renamed “${selected.title}” → “${title}” and preserved inbound wiki links.`);
  };

  const trashSelected = async () => {
    if (!selected || !confirm(`Move “${selected.title}” to local trash?`)) return;
    await moveNoteToTrash(selected); await refresh(); setStatus(`Moved “${selected.title}” to recoverable local trash.`);
  };

  const restoreTrash = async (id: string) => {
    const note = await restoreTrashedNote(id); await refresh(note.id); setStatus(`Restored “${note.title}” from local trash.`);
  };

  const snapshot = async () => {
    const record = await createNotesSnapshot(`Manual snapshot ${new Date().toLocaleString()}`, notes);
    setStatus(`Created local recovery snapshot ${record.id.slice(0, 8)}.`);
  };

  const importKnowledge = async (fileList: FileList | null) => {
    if (!fileList) return;
    let imported = 0; let duplicates = 0; const failures: string[] = [];
    for (const file of Array.from(fileList)) {
      try {
        const bundle = await ingestFile(file);
        const duplicate = await knowledgeDb.documents.where("sha256").equals(bundle.document.sha256).first();
        if (duplicate) { duplicates += 1; continue; }
        await knowledgeDb.transaction("rw", knowledgeDb.documents, knowledgeDb.blocks, async () => {
          await knowledgeDb.documents.put(bundle.document);
          await knowledgeDb.blocks.bulkPut(bundle.blocks);
        });
        imported += 1;
      } catch (error) { failures.push(`${file.name}: ${error instanceof Error ? error.message : "failed"}`); }
    }
    await refresh(); setView("documents");
    setStatus(`Imported ${imported} document${imported === 1 ? "" : "s"}; ${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped${failures.length ? `; ${failures.length} failed` : ""}.`);
  };

  const rebuildCandidates = async () => {
    const existingEntities = new Map(entities.map((item) => [item.id, item]));
    const freshEntities = extractEntityCandidates(sources).map((item) => existingEntities.has(item.id) ? { ...item, status: existingEntities.get(item.id)!.status, aliases: existingEntities.get(item.id)!.aliases } : item);
    const existingRelations = new Map(relations.map((item) => [item.id, item]));
    const freshRelations = extractRelationCandidates(sources, freshEntities).map((item) => existingRelations.has(item.id) ? { ...item, status: existingRelations.get(item.id)!.status } : item);
    await knowledgeDb.transaction("rw", knowledgeDb.entities, knowledgeDb.relations, async () => {
      await knowledgeDb.entities.clear(); await knowledgeDb.relations.clear();
      await knowledgeDb.entities.bulkPut(freshEntities); await knowledgeDb.relations.bulkPut(freshRelations);
    });
    await refresh(); setView("review"); setStatus(`Generated ${freshEntities.length} entity and ${freshRelations.length} relationship candidates. Nothing was auto-accepted.`);
  };

  const reviewEntity = async (entity: EntityCandidateRecord, accepted: boolean) => {
    await knowledgeDb.entities.put(updateReviewStatus(entity, accepted ? "accepted" : "rejected")); await refresh();
  };
  const reviewRelation = async (relation: RelationCandidateRecord, accepted: boolean) => {
    await knowledgeDb.relations.put(updateReviewStatus(relation, accepted ? "accepted" : "rejected")); await refresh();
  };

  const enableSemantic = async () => {
    try {
      setSemanticState("loading"); setStatus("Loading the optional local embedding model. First use downloads model files into browser cache; no paid API is used.");
      semanticProvider.current = await createTransformersProvider();
      setSemanticState("ready"); setStatus("Local semantic retrieval ready (Transformers.js, WebGPU/WASM). BM25 and graph retrieval remain available without it.");
    } catch (error) { setSemanticState("failed"); setStatus(error instanceof Error ? error.message : "Local embedding model failed to load."); }
  };

  const runEvidence = async () => {
    const hits = await hybridRetrieve(question, sources, entities, relations, semanticProvider.current, 8);
    setEvidence(hits); setVerified(verifyExtractive(question, hits)); setView("evidence");
    setStatus(hits.length ? `Retrieved ${hits.length} provenance-bearing blocks with BM25${semanticProvider.current ? " + local vectors" : ""}${relations.some((item) => item.status === "accepted") ? " + accepted graph" : ""} and RRF.` : "Evidence gap: no local source supports the query strongly enough.");
  };

  const runLocalLlm = async () => {
    try {
      if (!evidence.length) await runEvidence();
      const currentEvidence = evidence.length ? evidence : await hybridRetrieve(question, sources, entities, relations, semanticProvider.current, 8);
      setLlmProgress("Preparing local model…");
      const result = await generateWithWebLLM(question, currentEvidence, "Llama-3.2-1B-Instruct-q4f16_1-MLC", setLlmProgress);
      setEvidence(currentEvidence); setVerified(result); setLlmProgress("");
      setStatus(`Local WebLLM answer generated and post-validated: ${Math.round(result.coverage * 100)}% claim coverage.`);
    } catch (error) { setLlmProgress(""); setStatus(error instanceof Error ? error.message : "Local generation failed."); }
  };

  const exportAll = async () => {
    const bundle = await exportPortableWorkspace(notes);
    download(`evidenceweave-v1-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(bundle, null, 2));
  };

  const restoreAll = async (file?: File) => {
    if (!file) return;
    try { const bundle = validatePortableWorkspace(JSON.parse(await file.text())); await restorePortableWorkspace(bundle); await refresh(bundle.notes[0]?.id); setStatus(`Restored portable v1 workspace: ${bundle.notes.length} notes and ${bundle.documents.length} documents.`); }
    catch (error) { setStatus(error instanceof Error ? error.message : "Restore failed."); }
  };

  const openNote = (id: string) => { if (notes.some((note) => note.id === id)) { setSelectedId(id); setView("workspace"); } };

  return <div className="app-shell v1-shell">
    <header className="topbar">
      <div className="brand-mark">EW</div><div className="brand-copy"><strong>EvidenceWeave</strong><span>Graph Studio v1</span></div>
      <nav className="view-tabs" aria-label="Primary views">
        {(["workspace", "documents", "graph", "review", "evidence", "canvas", "library"] as MainView[]).map((item) => <button key={item} className={view === item ? "active" : ""} onClick={() => setView(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}
      </nav>
      <div className="local-badge"><span></span> LOCAL</div>
    </header>

    <aside className="sidebar">
      <div className="sidebar-actions studio-actions"><button className="primary" onClick={() => void createNote()}>+ New note</button><button onClick={() => void createDaily()}>Daily</button></div>
      <label className="search"><span>⌕</span><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search local notes" /></label>
      <div className="section-label">Notes <span>{notes.length}</span></div>
      <div className="note-list">{filteredNotes.map((note) => <button key={note.id} className={note.id === selectedId ? "note-row active" : "note-row"} onClick={() => openNote(note.id)}><strong>{note.title}</strong><small>{parseMarkdown(note.markdown).tags.slice(0, 2).map((tag) => `#${tag}`).join(" · ") || note.path}</small></button>)}</div>
      <div className="sidebar-footer">
        <label className="file-action">Import knowledge<input hidden type="file" multiple accept=".md,.txt,.csv,.html,.htm,.pdf,.docx,text/*,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => void importKnowledge(event.target.files)} /></label>
        <button className="file-action" onClick={() => void snapshot()}>Create snapshot</button>
        <button className="file-action" onClick={() => void exportAll()}>Export portable v1</button>
        <label className="file-action">Restore portable v1<input hidden type="file" accept=".json,application/json" onChange={(event) => void restoreAll(event.target.files?.[0])} /></label>
      </div>
    </aside>

    <main className="main-pane">
      {view === "workspace" && <WorkspaceView note={selected} notes={notes} graph={authoredGraph} mode={mode} setMode={setMode} save={saveSelected} rename={renameSelected} remove={trashSelected} openNote={openNote} />}
      {view === "documents" && <DocumentsView documents={documents} blocks={blocks} importKnowledge={importKnowledge} />}
      {view === "graph" && <GraphStudio graph={authoredGraph} entities={entities} relations={relations} onOpen={openNote} />}
      {view === "review" && <ReviewView entities={entities} relations={relations} blocks={sources} rebuild={rebuildCandidates} reviewEntity={reviewEntity} reviewRelation={reviewRelation} />}
      {view === "evidence" && <EvidenceStudio question={question} setQuestion={setQuestion} evidence={evidence} verified={verified} semanticState={semanticState} enableSemantic={enableSemantic} runEvidence={runEvidence} runLocalLlm={runLocalLlm} llmProgress={llmProgress} />}
      {view === "canvas" && <CanvasStudio canvases={canvases} notes={notes} selected={selected} refresh={refresh} />}
      {view === "library" && <LibraryStudio notes={notes} graph={authoredGraph} documents={documents} entities={entities} relations={relations} trash={trash} restoreTrash={restoreTrash} openNote={openNote} />}
    </main>
    <footer className="statusbar"><span>{status}</span><span>{sources.length} source blocks · {entities.filter((item) => item.status === "accepted").length} accepted entities · {relations.filter((item) => item.status === "accepted").length} accepted relations</span></footer>
  </div>;
}

function WorkspaceView({ note, notes, graph, mode, setMode, save, rename, remove, openNote }: { note?: NoteRecord; notes: NoteRecord[]; graph: KnowledgeGraph; mode: NoteMode; setMode: (mode: NoteMode) => void; save: (markdown: string) => void; rename: () => void; remove: () => void; openNote: (id: string) => void }) {
  if (!note) return <div className="empty-state"><h1>Own your knowledge.</h1><p>Create a note or import evidence to begin.</p></div>;
  const parsed = parseMarkdown(note.markdown); const backlinks = backlinksFor(note.id, graph, notes);
  return <div className="note-workspace"><section className="document-pane"><div className="document-header"><div><span className="eyebrow">{note.path}</span><h1>{note.title}</h1></div><div className="mode-switch"><button className={mode === "edit" ? "active" : ""} onClick={() => setMode("edit")}>Edit</button><button className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")}>Preview</button><button onClick={rename}>Rename</button><button onClick={remove}>Trash</button></div></div>{mode === "edit" ? <textarea aria-label="Markdown editor" className="editor" value={note.markdown} onChange={(event) => void save(event.target.value)} /> : <article className="preview prose" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(parsed.body, { async: false }) as string) }} />}</section><aside className="inspector"><div className="panel"><div className="panel-title">Properties</div>{Object.entries(parsed.properties).map(([key, value]) => <div className="property" key={key}><span>{key}</span><code>{Array.isArray(value) ? value.join(", ") : String(value)}</code></div>)}</div><div className="panel"><div className="panel-title">Links <span>{parsed.links.length}</span></div>{parsed.links.map((link, index) => <div className="link-chip" key={`${link.raw}-${index}`}>→ {link.target}</div>)}</div><div className="panel"><div className="panel-title">Backlinks <span>{backlinks.length}</span></div>{backlinks.map((item) => <button className="inspector-link" key={item.id} onClick={() => openNote(item.id)}>← {item.title}</button>)}</div></aside></div>;
}

function DocumentsView({ documents, blocks, importKnowledge }: { documents: SourceDocumentRecord[]; blocks: DocumentBlockRecord[]; importKnowledge: (files: FileList | null) => Promise<void> }) {
  return <div className="single-view"><span className="eyebrow">Document intelligence</span><h1>Every extracted block keeps its source.</h1><p className="lede">PDF pages, CSV rows, DOCX/HTML sections, and text offsets are stored locally with hashes and extractor versions.</p><label className="primary import-hero">Import PDF / DOCX / CSV / HTML / text<input hidden type="file" multiple accept=".md,.txt,.csv,.html,.htm,.pdf,.docx" onChange={(event) => void importKnowledge(event.target.files)} /></label><div className="document-grid">{documents.map((document) => { const sourceBlocks = blocks.filter((block) => block.documentId === document.id); return <article className="document-card" key={document.id}><div className="doc-kind">{document.format.toUpperCase()}</div><h3>{document.name}</h3><p>{sourceBlocks.length} blocks · {(document.size / 1024).toFixed(1)} KiB</p><code>{document.sha256.slice(0, 20)}…</code><small>{document.extractorVersion}</small>{sourceBlocks.slice(0, 2).map((block) => <div className="source-mini" key={block.id}><strong>{formatLocation(block.location)}</strong><span>{block.text.slice(0, 110)}{block.text.length > 110 ? "…" : ""}</span></div>)}</article>; })}{!documents.length && <div className="empty-evidence">No imported documents yet.</div>}</div></div>;
}

function GraphStudio({ graph, entities, relations, onOpen }: { graph: KnowledgeGraph; entities: EntityCandidateRecord[]; relations: RelationCandidateRecord[]; onOpen: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null); const openRef = useRef(onOpen); useEffect(() => { openRef.current = onOpen; }, [onOpen]);
  const acceptedEntities = entities.filter((item) => item.status === "accepted"); const acceptedRelations = relations.filter((item) => item.status === "accepted");
  useEffect(() => { let destroyed = false; let cleanup: (() => void) | undefined; void import("cytoscape").then(({ default: cytoscape }) => { if (destroyed || !ref.current) return; const cy = cytoscape({ container: ref.current, elements: [...graph.nodes.map((node) => ({ data: { id: `note:${node.id}`, label: node.title, kind: node.kind } })), ...graph.edges.map((edge) => ({ data: { id: `authored:${edge.id}`, source: `note:${edge.source}`, target: `note:${edge.target}`, layer: "authored" } })), ...acceptedEntities.map((entity) => ({ data: { id: `entity:${entity.id}`, label: entity.canonicalName, kind: "entity" } })), ...acceptedRelations.map((relation) => ({ data: { id: `inferred:${relation.id}`, source: `entity:${relation.sourceEntityId}`, target: `entity:${relation.targetEntityId}`, layer: "inferred", label: relation.relation } }))], style: [{ selector: "node", style: { "background-color": "#7c8cff", label: "data(label)", color: "#dfe4ef", "font-size": 10, "text-valign": "bottom", "text-margin-y": 7, width: 22, height: 22 } }, { selector: 'node[kind = "entity"]', style: { "background-color": "#53cfa1", shape: "round-rectangle", width: 28, height: 18 } }, { selector: 'node[kind = "unresolved"]', style: { "background-color": "#343b4b", "border-color": "#f4b860", "border-width": 2, "border-style": "dashed" } }, { selector: "edge", style: { width: 1.2, "line-color": "#49536a", "target-arrow-color": "#49536a", "target-arrow-shape": "triangle", "curve-style": "bezier" } }, { selector: 'edge[layer = "inferred"]', style: { "line-style": "dashed", "line-color": "#53cfa1", "target-arrow-color": "#53cfa1" } }], layout: { name: "cose", animate: false, padding: 30 } }); cy.on("tap", "node", (event) => { const id = event.target.id() as string; if (id.startsWith("note:")) openRef.current(id.slice(5)); }); cleanup = () => cy.destroy(); }); return () => { destroyed = true; cleanup?.(); }; }, [graph, acceptedEntities, acceptedRelations]);
  return <div className="single-view"><span className="eyebrow">Layered knowledge graph</span><h1>Authored truth and reviewed inference stay distinct.</h1><p className="lede">Purple nodes/solid edges are authored Markdown. Green nodes/dashed edges are inferred knowledge that you explicitly accepted.</p><div className="legend"><span><i className="dot resolved"></i>Authored</span><span className="green-dot">● Accepted inferred</span><span>{acceptedRelations.length} reviewed inferred edges</span></div><div ref={ref} className="graph-canvas graph-v1" /></div>;
}

function ReviewView({ entities, relations, blocks, rebuild, reviewEntity, reviewRelation }: { entities: EntityCandidateRecord[]; relations: RelationCandidateRecord[]; blocks: ReturnType<typeof noteBlocks>; rebuild: () => Promise<void>; reviewEntity: (entity: EntityCandidateRecord, accepted: boolean) => Promise<void>; reviewRelation: (relation: RelationCandidateRecord, accepted: boolean) => Promise<void> }) {
  const pendingEntities = entities.filter((item) => item.status === "pending"); const pendingRelations = relations.filter((item) => item.status === "pending"); const blockMap = new Map(blocks.map((block) => [block.id, block]));
  return <div className="single-view"><div className="hero-row"><div><span className="eyebrow">Human review queue</span><h1>Inference proposes. You decide.</h1><p>Rejected knowledge never becomes graph truth; accepted relationships always retain source-block evidence.</p></div><button className="primary" onClick={() => void rebuild()}>Rebuild candidates</button></div><div className="review-columns"><section><h2>Entities <span>{pendingEntities.length}</span></h2>{pendingEntities.slice(0, 80).map((entity) => <article className="review-card" key={entity.id}><div><strong>{entity.canonicalName}</strong><small>{entity.entityType} · {Math.round(entity.confidence * 100)}%</small></div><p>{entity.evidenceBlockIds.slice(0, 2).map((id) => blockMap.get(id)?.title).filter(Boolean).join(" · ")}</p><div className="review-actions"><button onClick={() => void reviewEntity(entity, true)}>Accept</button><button onClick={() => void reviewEntity(entity, false)}>Reject</button></div></article>)}</section><section><h2>Relationships <span>{pendingRelations.length}</span></h2>{pendingRelations.slice(0, 80).map((relation) => <article className="review-card" key={relation.id}><div><strong>{entities.find((item) => item.id === relation.sourceEntityId)?.canonicalName ?? relation.sourceEntityId}</strong><small> {relation.relation} → </small><strong>{entities.find((item) => item.id === relation.targetEntityId)?.canonicalName ?? relation.targetEntityId}</strong></div><p>{relation.evidenceBlockIds.map((id) => blockMap.get(id)?.title).filter(Boolean).slice(0, 2).join(" · ")} · {Math.round(relation.confidence * 100)}%</p><div className="review-actions"><button onClick={() => void reviewRelation(relation, true)}>Accept</button><button onClick={() => void reviewRelation(relation, false)}>Reject</button></div></article>)}</section></div></div>;
}

function EvidenceStudio({ question, setQuestion, evidence, verified, semanticState, enableSemantic, runEvidence, runLocalLlm, llmProgress }: { question: string; setQuestion: (value: string) => void; evidence: RankedEvidence[]; verified?: VerifiedAnswer; semanticState: string; enableSemantic: () => Promise<void>; runEvidence: () => Promise<void>; runLocalLlm: () => Promise<void>; llmProgress: string }) {
  return <div className="single-view evidence-view"><span className="eyebrow">Hybrid GraphRAG + verification</span><h1>Verify every answer.</h1><p className="lede">BM25 is always local. Semantic retrieval is optional and runs in-browser via Transformers.js. Accepted graph evidence joins through RRF. Local generation is optional WebLLM and is validated after generation.</p><div className="ask-box"><input aria-label="Evidence question" value={question} onChange={(event) => setQuestion(event.target.value)} /><button className="primary" onClick={() => void runEvidence()}>Retrieve</button></div><div className="engine-controls"><button onClick={() => void enableSemantic()} disabled={semanticState === "loading" || semanticState === "ready"}>{semanticState === "ready" ? "Semantic ready" : semanticState === "loading" ? "Loading semantic…" : "Enable local semantic"}</button><button onClick={() => void runLocalLlm()} disabled={!evidence.length && !question.trim()}>Generate with local WebLLM</button><span>{llmProgress}</span></div>{verified && <section className="answer-proof"><div className="answer-head"><strong>{verified.mode === "webllm" ? "Local generated answer" : "Extractive evidence answer"}</strong><span className={verified.coverage >= .8 ? "coverage good" : "coverage warn"}>{Math.round(verified.coverage * 100)}% claim coverage</span></div><p>{verified.answer}</p>{verified.claims.some((claim) => !claim.supported) && <div className="claim-warning">Unsupported or weakly supported claims are flagged rather than silently treated as verified.</div>}</section>}<div className="evidence-list">{evidence.map((hit, index) => <article className="evidence-card" key={hit.block.id}><div className="evidence-head"><span>S{index + 1}</span><button>{hit.block.title}</button><strong>RRF {hit.fusedScore.toFixed(4)}</strong></div><p>{hit.block.text}</p><div className="rank-grid"><code>BM25 #{hit.ranks.bm25 ?? "–"}</code><code>Vector #{hit.ranks.vector ?? "–"}</code><code>Graph #{hit.ranks.graph ?? "–"}</code><code>{hit.block.page ? `page ${hit.block.page}` : hit.block.row ? `row ${hit.block.row}` : hit.block.startOffset !== undefined ? `chars ${hit.block.startOffset}–${hit.block.endOffset}` : "source block"}</code></div></article>)}</div>{!evidence.length && <div className="empty-evidence">Run retrieval. If the workspace cannot support the question, EvidenceWeave will fail closed.</div>}</div>;
}

function CanvasStudio({ canvases, notes, selected, refresh }: { canvases: CanvasRecord[]; notes: NoteRecord[]; selected?: NoteRecord; refresh: () => Promise<void> }) {
  const [activeId, setActiveId] = useState(canvases[0]?.id ?? ""); useEffect(() => { if (!activeId && canvases[0]) setActiveId(canvases[0].id); }, [canvases, activeId]); const canvas = canvases.find((item) => item.id === activeId);
  const ensureCanvas = async () => { const next = createCanvas(); await knowledgeDb.canvases.put(next); setActiveId(next.id); await refresh(); };
  const addSelected = async () => { if (!selected) return; let current = canvas; if (!current) { current = createCanvas(); await knowledgeDb.canvases.put(current); setActiveId(current.id); } const next = addCanvasNode(current, { kind: "note", refId: selected.id, label: selected.title, x: 80 + current.nodes.length * 35, y: 70 + current.nodes.length * 25, width: 190, height: 90 }); await knowledgeDb.canvases.put(next); await refresh(); };
  const move = async (nodeId: string, dx: number, dy: number) => { if (!canvas) return; const node = canvas.nodes.find((item) => item.id === nodeId); if (!node) return; await knowledgeDb.canvases.put(moveCanvasNode(canvas, nodeId, node.x + dx, node.y + dy)); await refresh(); };
  return <div className="single-view canvas-view"><div className="hero-row"><div><span className="eyebrow">Open local canvas</span><h1>Arrange knowledge spatially.</h1><p>Canvas metadata is local/exportable and never replaces the underlying Markdown.</p></div><div className="canvas-actions"><button onClick={() => void ensureCanvas()}>New canvas</button><button className="primary" onClick={() => void addSelected()} disabled={!selected}>Add current note</button></div></div><div className="canvas-tabs">{canvases.map((item) => <button className={item.id === activeId ? "active" : ""} key={item.id} onClick={() => setActiveId(item.id)}>{item.title}</button>)}</div><div className="infinite-canvas">{canvas?.nodes.map((node) => <article className="canvas-node" key={node.id} style={{ left: node.x, top: node.y, width: node.width, minHeight: node.height }}><strong>{node.label}</strong><small>{node.kind}{node.refId && notes.some((note) => note.id === node.refId) ? " · linked" : ""}</small><div><button onClick={() => void move(node.id, -40, 0)}>←</button><button onClick={() => void move(node.id, 0, -40)}>↑</button><button onClick={() => void move(node.id, 0, 40)}>↓</button><button onClick={() => void move(node.id, 40, 0)}>→</button></div></article>)}</div></div>;
}

function LibraryStudio({ notes, graph, documents, entities, relations, trash, restoreTrash, openNote }: { notes: NoteRecord[]; graph: KnowledgeGraph; documents: SourceDocumentRecord[]; entities: EntityCandidateRecord[]; relations: RelationCandidateRecord[]; trash: TrashRecord[]; restoreTrash: (id: string) => Promise<void>; openNote: (id: string) => void }) {
  return <div className="single-view"><span className="eyebrow">Knowledge library</span><h1>Structured, recoverable, portable.</h1><div className="metric-row"><div><strong>{notes.length}</strong><span>Notes</span></div><div><strong>{documents.length}</strong><span>Documents</span></div><div><strong>{graph.edges.filter((edge) => edge.resolved).length}</strong><span>Authored links</span></div><div><strong>{relations.filter((item) => item.status === "accepted").length}</strong><span>Accepted relations</span></div></div><div className="library-split"><section><h2>Notes</h2>{notes.map((note) => <button className="library-row" key={note.id} onClick={() => openNote(note.id)}><strong>{note.title}</strong><span>{note.path}</span></button>)}</section><section><h2>Local trash <span>{trash.length}</span></h2>{trash.map((item) => <div className="trash-row" key={item.id}><span>{item.kind} · {new Date(item.deletedAt).toLocaleString()}</span>{item.kind === "note" && <button onClick={() => void restoreTrash(item.id)}>Restore</button>}</div>)}<h2>Reviewed knowledge</h2><p className="muted">{entities.filter((item) => item.status === "accepted").length} accepted entities · {entities.filter((item) => item.status === "rejected").length} rejected entities</p></section></div></div>;
}
