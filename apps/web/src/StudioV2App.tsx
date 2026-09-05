import { useEffect, useMemo, useRef, useState } from "react";
import WorkspaceTools from "./WorkspaceTools";
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
import { formatLocation, ingestFile } from "./lib/documents";
import { extractEntityCandidates, extractRelationCandidates } from "./lib/entities";
import { runEvidenceQuery, type EvidenceQueryTrace } from "./lib/engine";
import {
  createTransformersProvider,
  documentBlocks,
  noteBlocks,
  type EmbeddingProvider,
  type RankedEvidence,
  type UnifiedSourceBlock
} from "./lib/hybrid";
import { connectedComponents } from "./lib/reasoning";
import {
  mergeEntities,
  reconcileEntityReview,
  reconcileRelationReview,
  renameEntity,
  reviewEntity as persistEntityReview,
  reviewRelation as persistRelationReview,
  setEntityPinned,
  splitEntity
} from "./lib/review";
import { undoReviewAudit } from "./lib/review-undo";
import { createLocalNerProvider, extractLocalModelEntityCandidates, type LocalNerProvider } from "./lib/local-ner";
import { buildSemanticLinkSuggestions, reviewSemanticLink } from "./lib/semantic-links";
import { loadWorkspaceState, saveWorkspaceState, touchRecentNote } from "./lib/workspace-state";
import {
  knowledgeDb,
  type CanvasRecord,
  type DocumentBlockRecord,
  type EntityCandidateRecord,
  type QueryTraceRecord,
  type RelationCandidateRecord,
  type ReviewAuditRecord,
  type SavedViewRecord,
  type SemanticLinkSuggestionRecord,
  type SnapshotRecord,
  type SourceDocumentRecord,
  type TrashRecord
} from "./lib/store";
import { generateWithWebLLM, verifyExtractive, type VerifiedAnswer } from "./lib/verify";
import {
  addCanvasEdge,
  addCanvasNode,
  assignCanvasGroup,
  createCanvas,
  createSavedView,
  dailyNoteTitle,
  expandTemplate,
  exportCanvas,
  groupNotesForView,
  importCanvas,
  moveCanvasNode,
  removeCanvasNode,
  resizeCanvasNode
} from "./lib/workspace";
import {
  createNotesSnapshot,
  moveNoteToTrash,
  restoreNotesSnapshot,
  restoreTrashedNote
} from "./lib/recovery";
import { exportPortableWorkspace, restorePortableWorkspace, validatePortableWorkspace } from "./lib/portable";

type MainView = "workspace" | "documents" | "graph" | "review" | "evidence" | "canvas" | "library";
type NoteMode = "edit" | "preview";
type SemanticState = "off" | "loading" | "ready" | "failed";

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

export default function StudioV2App() {
  const [notes, setNotes] = useState<NoteRecord[]>([]);
  const [documents, setDocuments] = useState<SourceDocumentRecord[]>([]);
  const [blocks, setBlocks] = useState<DocumentBlockRecord[]>([]);
  const [entities, setEntities] = useState<EntityCandidateRecord[]>([]);
  const [relations, setRelations] = useState<RelationCandidateRecord[]>([]);
  const [canvases, setCanvases] = useState<CanvasRecord[]>([]);
  const [views, setViews] = useState<SavedViewRecord[]>([]);
  const [trash, setTrash] = useState<TrashRecord[]>([]);
  const [snapshots, setSnapshots] = useState<SnapshotRecord[]>([]);
  const [reviewAudit, setReviewAudit] = useState<ReviewAuditRecord[]>([]);
  const [queryTraces, setQueryTraces] = useState<QueryTraceRecord[]>([]);
  const [semanticSuggestions, setSemanticSuggestions] = useState<SemanticLinkSuggestionRecord[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [view, setView] = useState<MainView>("workspace");
  const [mode, setMode] = useState<NoteMode>("edit");
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState("Local-first · no account · no required API key");
  const [question, setQuestion] = useState("How are Welcome and GraphRAG connected, and what evidence supports provenance?");
  const [evidence, setEvidence] = useState<RankedEvidence[]>([]);
  const [trace, setTrace] = useState<EvidenceQueryTrace>();
  const [verified, setVerified] = useState<VerifiedAnswer>();
  const [semanticState, setSemanticState] = useState<SemanticState>("off");
  const [semanticProgress, setSemanticProgress] = useState("");
  const [llmProgress, setLlmProgress] = useState("");
  const semanticProvider = useRef<EmbeddingProvider | undefined>(undefined);
  const localNerProvider = useRef<LocalNerProvider | undefined>(undefined);

  const refresh = async (preferId?: string) => {
    const [
      nextNotes,
      nextDocuments,
      nextBlocks,
      nextEntities,
      nextRelations,
      nextCanvases,
      nextViews,
      nextTrash,
      nextSnapshots,
      nextAudit,
      nextTraces,
      nextSemanticSuggestions
    ] = await Promise.all([
      db.notes.orderBy("updatedAt").reverse().toArray(),
      knowledgeDb.documents.orderBy("importedAt").reverse().toArray(),
      knowledgeDb.blocks.toArray(),
      knowledgeDb.entities.orderBy("updatedAt").reverse().toArray(),
      knowledgeDb.relations.orderBy("updatedAt").reverse().toArray(),
      knowledgeDb.canvases.orderBy("updatedAt").reverse().toArray(),
      knowledgeDb.views.orderBy("updatedAt").reverse().toArray(),
      knowledgeDb.trash.orderBy("deletedAt").reverse().toArray(),
      knowledgeDb.snapshots.orderBy("createdAt").reverse().toArray(),
      knowledgeDb.reviewAudit.orderBy("createdAt").reverse().toArray(),
      knowledgeDb.queryTraces.orderBy("createdAt").reverse().toArray(),
      knowledgeDb.semanticSuggestions.orderBy("updatedAt").reverse().toArray()
    ]);
    setNotes(nextNotes);
    setDocuments(nextDocuments);
    setBlocks(nextBlocks);
    setEntities(nextEntities);
    setRelations(nextRelations);
    setCanvases(nextCanvases);
    setViews(nextViews);
    setTrash(nextTrash);
    setSnapshots(nextSnapshots);
    setReviewAudit(nextAudit);
    setQueryTraces(nextTraces);
    setSemanticSuggestions(nextSemanticSuggestions);
    setSelectedId((current) => {
      if (preferId && nextNotes.some((note) => note.id === preferId)) return preferId;
      if (current && nextNotes.some((note) => note.id === current)) return current;
      return nextNotes[0]?.id ?? "";
    });
  };

  useEffect(() => {
    void seedIfEmpty().then(async () => {
      const saved = await loadWorkspaceState();
      await refresh(saved.activeNoteId);
      const validViews: MainView[] = ["workspace", "documents", "graph", "review", "evidence", "canvas", "library"];
      if (validViews.includes(saved.activeView as MainView)) setView(saved.activeView as MainView);
    });
  }, []);

  useEffect(() => {
    void saveWorkspaceState({ activeView: view, activeNoteId: selectedId || undefined });
  }, [view, selectedId]);

  useEffect(() => () => {
    semanticProvider.current?.dispose?.();
    localNerProvider.current?.dispose?.();
  }, []);

  const selected = notes.find((note) => note.id === selectedId);
  const authoredGraph = useMemo(() => buildAuthoredGraph(notes), [notes]);
  const sources = useMemo(() => [...noteBlocks(notes), ...documentBlocks(blocks)], [notes, blocks]);
  const filteredNotes = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase();
    if (!needle) return notes;
    return notes.filter((note) => `${note.title}\n${note.markdown}`.toLocaleLowerCase().includes(needle));
  }, [notes, filter]);

  const createNote = async (requested = "Untitled", markdown?: string) => {
    const title = makeUniqueTitle(requested, notes);
    const id = crypto.randomUUID();
    const now = stamp();
    const note: NoteRecord = {
      id,
      title,
      path: safePath(title),
      markdown: markdown ?? `# ${title}\n\nStart writing. Connect knowledge with [[Note Title]].`,
      createdAt: now,
      updatedAt: now
    };
    await db.notes.add(note);
    await refresh(id);
    setView("workspace");
    setMode("edit");
  };

  const createDaily = async () => {
    const title = dailyNoteTitle(new Date());
    const existing = notes.find((note) => note.title === title);
    if (existing) {
      setSelectedId(existing.id);
      setView("workspace");
      return;
    }
    const body = expandTemplate(
      "---\ntype: daily\ndate: {{date}}\nstatus: open\n---\n# {{title}}\n\n## Focus\n\n## Notes\n\n## Evidence captured\n",
      new Date(),
      { title }
    );
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
    const renamed: NoteRecord = {
      ...selected,
      title,
      path: safePath(title),
      markdown: selected.markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() === selected.title
        ? selected.markdown.replace(/^#\s+(.+)$/m, `# ${title}`)
        : selected.markdown,
      updatedAt: now
    };
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
    await moveNoteToTrash(selected);
    await refresh();
    setStatus(`Moved “${selected.title}” to recoverable local trash.`);
  };

  const restoreTrash = async (id: string) => {
    const note = await restoreTrashedNote(id);
    await refresh(note.id);
    setStatus(`Restored “${note.title}” from local trash.`);
  };

  const snapshot = async () => {
    const record = await createNotesSnapshot(`Manual snapshot ${new Date().toLocaleString()}`, notes);
    await refresh();
    setStatus(`Created local recovery snapshot ${record.id.slice(0, 8)}.`);
  };

  const restoreSnapshot = async (snapshotId: string) => {
    if (!confirm("Restore this note snapshot? Current notes will be replaced. A portable workspace export is recommended first.")) return;
    const restored = await restoreNotesSnapshot(snapshotId);
    await refresh(restored[0]?.id);
    setStatus(`Restored ${restored.length} notes from local snapshot.`);
  };

  const importKnowledge = async (fileList: FileList | null) => {
    if (!fileList) return;
    let imported = 0;
    let duplicates = 0;
    const failures: string[] = [];
    for (const file of Array.from(fileList)) {
      try {
        const bundle = await ingestFile(file);
        const duplicate = await knowledgeDb.documents.where("sha256").equals(bundle.document.sha256).first();
        if (duplicate) {
          duplicates += 1;
          continue;
        }
        await knowledgeDb.transaction("rw", [knowledgeDb.documents, knowledgeDb.blocks], async () => {
          await knowledgeDb.documents.put(bundle.document);
          await knowledgeDb.blocks.bulkPut(bundle.blocks);
        });
        imported += 1;
      } catch (error) {
        failures.push(`${file.name}: ${error instanceof Error ? error.message : "failed"}`);
      }
    }
    await refresh();
    setView("documents");
    setStatus(`Imported ${imported} document${imported === 1 ? "" : "s"}; ${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped${failures.length ? `; ${failures.length} failed` : ""}.`);
  };

  const rebuildCandidates = async () => {
    const existingEntities = new Map(entities.map((item) => [item.id, item]));
    const freshEntities = extractEntityCandidates(sources).map((item) => reconcileEntityReview(existingEntities.get(item.id), item));
    const existingRelations = new Map(relations.map((item) => [item.id, item]));
    const freshRelations = extractRelationCandidates(sources, freshEntities).map((item) => reconcileRelationReview(existingRelations.get(item.id), item));
    await knowledgeDb.transaction("rw", [knowledgeDb.entities, knowledgeDb.relations], async () => {
      await knowledgeDb.entities.clear();
      await knowledgeDb.relations.clear();
      await knowledgeDb.entities.bulkPut(freshEntities);
      await knowledgeDb.relations.bulkPut(freshRelations);
    });
    await refresh();
    setView("review");
    setStatus(`Generated ${freshEntities.length} entity and ${freshRelations.length} relationship candidates. Previous decisions are kept only when extractor versions still match.`);
  };

  const runLocalNer = async () => {
    try {
      setStatus("Loading optional local NER model. First use downloads model files; all inference stays in this browser.");
      localNerProvider.current ??= await createLocalNerProvider();
      const provider = localNerProvider.current;
      const previousByKey = new Map(entities.map((entity) => [`${entity.entityType}:${entity.normalizedName}`, entity]));
      const modelCandidates = await extractLocalModelEntityCandidates(sources, provider, {
        onProgress: (completed, total) => setStatus(`Local NER ${completed}/${total} source blocks…`)
      });
      const candidates = modelCandidates.flatMap((candidate) => {
        const key = `${candidate.entityType}:${candidate.normalizedName}`;
        const previous = previousByKey.get(key);
        if (previous && !previous.extractorVersion.startsWith("local-ner:")) return [];
        return [reconcileEntityReview(previous, candidate)];
      });
      if (candidates.length) await knowledgeDb.entities.bulkPut(candidates);
      await refresh();
      setView("review");
      setStatus(`Optional local NER proposed ${candidates.length} additional pending candidate${candidates.length === 1 ? "" : "s"}; deterministic candidates remain authoritative until review.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Local NER failed.");
    }
  };

  const buildSemanticSuggestions = async () => {
    try {
      if (!semanticProvider.current) {
        setSemanticState("loading");
        setStatus("Loading the pinned local embedding model before semantic-link analysis…");
        semanticProvider.current = await createTransformersProvider();
        setSemanticState("ready");
      }
      const suggestions = await buildSemanticLinkSuggestions(entities, semanticProvider.current);
      await refresh();
      setView("review");
      setStatus(`Generated ${suggestions.length} separate semantic-link suggestion${suggestions.length === 1 ? "" : "s"}. No authored or inferred graph edge was mutated.`);
    } catch (error) {
      setSemanticState("failed");
      setStatus(error instanceof Error ? error.message : "Semantic-link analysis failed.");
    }
  };

  const reviewSemanticSuggestion = async (id: string, accepted: boolean) => {
    await reviewSemanticLink(id, accepted ? "accepted" : "rejected");
    await refresh();
  };

  const reviewEntity = async (entity: EntityCandidateRecord, accepted: boolean) => {
    await persistEntityReview(entity, accepted ? "accepted" : "rejected");
    await refresh();
  };

  const reviewRelation = async (relation: RelationCandidateRecord, accepted: boolean) => {
    await persistRelationReview(relation, accepted ? "accepted" : "rejected");
    await refresh();
  };

  const renameReviewedEntity = async (entity: EntityCandidateRecord) => {
    const desired = prompt("Canonical entity name", entity.canonicalName)?.trim();
    if (!desired || desired === entity.canonicalName) return;
    await renameEntity(entity, desired);
    await refresh();
  };

  const togglePin = async (entity: EntityCandidateRecord) => {
    await setEntityPinned(entity, !entity.pinned);
    await refresh();
  };

  const mergeReviewedEntity = async (primary: EntityCandidateRecord) => {
    const desired = prompt("Merge which entity into this one? Enter its exact name or ID.")?.trim();
    if (!desired) return;
    const secondary = entities.find((entity) => entity.id !== primary.id && (entity.id === desired || entity.canonicalName.toLocaleLowerCase() === desired.toLocaleLowerCase()));
    if (!secondary) {
      setStatus(`No entity matched “${desired}”.`);
      return;
    }
    await mergeEntities(primary, secondary);
    await refresh();
    setStatus(`Merged “${secondary.canonicalName}” into “${primary.canonicalName}”; aliases, evidence and affected relations were preserved.`);
  };

  const splitReviewedEntity = async (entity: EntityCandidateRecord) => {
    if (entity.evidenceBlockIds.length < 2) {
      setStatus("This entity has only one evidence block, so there is nothing safe to split.");
      return;
    }
    const desired = prompt("Name for the new split entity")?.trim();
    if (!desired) return;
    await splitEntity(entity, desired, [entity.evidenceBlockIds[0]]);
    await refresh();
    setStatus(`Split one evidence observation from “${entity.canonicalName}” into pending entity “${desired}”.`);
  };

  const undoAuditAction = async (auditId: string) => {
    try {
      await undoReviewAudit(auditId);
      await refresh();
      setStatus("Reversed the selected review mutation from its audited before-snapshot.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Audit undo failed.");
    }
  };

  const enableSemantic = async () => {
    try {
      setSemanticState("loading");
      setSemanticProgress("Loading local embedding runtime…");
      setStatus("Loading the optional local embedding model. First use downloads model files into browser cache; no paid API is used.");
      semanticProvider.current = await createTransformersProvider();
      setSemanticState("ready");
      setSemanticProgress("Model ready; block vectors are cached lazily and invalidated by content hash.");
      setStatus("Local semantic retrieval ready. BM25 and reviewed graph retrieval remain available without it.");
    } catch (error) {
      setSemanticState("failed");
      setSemanticProgress("");
      setStatus(error instanceof Error ? error.message : "Local embedding model failed to load.");
    }
  };

  const executeEvidence = async () => {
    const result = await runEvidenceQuery({
      question,
      blocks: sources,
      entities,
      relations,
      provider: semanticProvider.current,
      limit: 8,
      semanticProgress: (progress) => setSemanticProgress(`Semantic index ${progress.completed}/${progress.total} · reused ${progress.reused} · created ${progress.created}`)
    });
    setEvidence(result.evidence);
    setTrace(result.trace);
    setVerified(verifyExtractive(question, result.evidence));
    await refresh();
    setView("evidence");
    setStatus(result.evidence.length
      ? `Route: ${result.trace.route.mode}. Retrieved ${result.evidence.length} provenance-bearing blocks with BM25${semanticProvider.current ? " + cached local vectors" : ""}${relations.some((item) => item.status === "accepted") ? " + accepted graph" : ""} and RRF.`
      : "Evidence gap: no local source supports the query strongly enough.");
    return result;
  };

  const runEvidence = async () => {
    try {
      await executeEvidence();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Evidence retrieval failed.");
    }
  };

  const runLocalLlm = async () => {
    try {
      const current = evidence.length ? { evidence, trace } : await executeEvidence();
      if (!current.evidence.length) {
        setStatus("Evidence gap: local generation was not started because retrieval found no supported source blocks.");
        return;
      }
      setLlmProgress("Preparing local model…");
      const result = await generateWithWebLLM(question, current.evidence, "Llama-3.2-1B-Instruct-q4f16_1-MLC", setLlmProgress);
      setEvidence(current.evidence);
      setVerified(result);
      setLlmProgress("");
      setStatus(`Local WebLLM answer generated and post-validated: ${Math.round(result.coverage * 100)}% claim coverage.`);
    } catch (error) {
      setLlmProgress("");
      setStatus(error instanceof Error ? error.message : "Local generation failed.");
    }
  };

  const exportAll = async () => {
    const bundle = await exportPortableWorkspace(notes);
    download(`evidenceweave-v3-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(bundle, null, 2));
  };

  const restoreAll = async (file?: File) => {
    if (!file) return;
    try {
      const bundle = validatePortableWorkspace(JSON.parse(await file.text()));
      await restorePortableWorkspace(bundle);
      await refresh(bundle.notes[0]?.id);
      setStatus(`Restored portable v3 workspace: ${bundle.notes.length} notes, ${bundle.documents.length} documents, ${bundle.reviewAudit.length} audit events and ${bundle.queryTraces.length} query traces. Semantic vectors will rebuild locally as needed.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Restore failed.");
    }
  };

  const openNote = (id: string) => {
    if (!notes.some((note) => note.id === id)) return;
    setSelectedId(id);
    setView("workspace");
    void loadWorkspaceState().then((current) => knowledgeDb.workspaceState.put(touchRecentNote(current, id)));
  };

  return (
    <div className="app-shell v1-shell v2-shell">
      <header className="topbar">
        <div className="brand-mark">EW</div>
        <div className="brand-copy"><strong>EvidenceWeave</strong><span>Graph Studio v1.0</span></div>
        <nav className="view-tabs" aria-label="Primary views">
          {(["workspace", "documents", "graph", "review", "evidence", "canvas", "library"] as MainView[]).map((item) => (
            <button key={item} className={view === item ? "active" : ""} onClick={() => setView(item)}>
              {item[0].toUpperCase() + item.slice(1)}
            </button>
          ))}
        </nav>
        <div className="local-badge"><span></span> LOCAL</div>
      </header>

      <aside className="sidebar">
        <div className="sidebar-actions studio-actions">
          <button className="primary" onClick={() => void createNote()}>+ New note</button>
          <button onClick={() => void createDaily()}>Daily</button>
        </div>
        <label className="search"><span>⌕</span><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search local notes" /></label>
        <div className="section-label">Notes <span>{notes.length}</span></div>
        <div className="note-list">
          {filteredNotes.map((note) => (
            <button key={note.id} className={note.id === selectedId ? "note-row active" : "note-row"} onClick={() => openNote(note.id)}>
              <strong>{note.title}</strong>
              <small>{parseMarkdown(note.markdown).tags.slice(0, 2).map((tag) => `#${tag}`).join(" · ") || note.path}</small>
            </button>
          ))}
        </div>
        <WorkspaceTools notes={notes} createNote={createNote} openNote={openNote} onChanged={refresh} />
        <div className="sidebar-footer">
          <label className="file-action">Import knowledge<input hidden type="file" multiple accept=".md,.txt,.csv,.html,.htm,.pdf,.docx,text/*,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => void importKnowledge(event.target.files)} /></label>
          <button className="file-action" onClick={() => void snapshot()}>Create snapshot</button>
          <button className="file-action" onClick={() => void exportAll()}>Export portable v3</button>
          <label className="file-action">Restore portable v1/v2/v3<input hidden type="file" accept=".json,application/json" onChange={(event) => void restoreAll(event.target.files?.[0])} /></label>
        </div>
      </aside>

      <main className="main-pane">
        {view === "workspace" && <WorkspaceView note={selected} notes={notes} graph={authoredGraph} mode={mode} setMode={setMode} save={saveSelected} rename={renameSelected} remove={trashSelected} openNote={openNote} />}
        {view === "documents" && <DocumentsView documents={documents} blocks={blocks} importKnowledge={importKnowledge} />}
        {view === "graph" && <GraphStudio graph={authoredGraph} entities={entities} relations={relations} onOpen={openNote} />}
        {view === "review" && <ReviewView entities={entities} relations={relations} blocks={sources} audit={reviewAudit} rebuild={rebuildCandidates} reviewEntity={reviewEntity} reviewRelation={reviewRelation} renameEntity={renameReviewedEntity} togglePin={togglePin} mergeEntity={mergeReviewedEntity} splitEntity={splitReviewedEntity} undoAudit={undoAuditAction} runLocalNer={runLocalNer} buildSemanticSuggestions={buildSemanticSuggestions} semanticSuggestions={semanticSuggestions} reviewSemanticSuggestion={reviewSemanticSuggestion} />}
        {view === "evidence" && <EvidenceStudio question={question} setQuestion={setQuestion} evidence={evidence} trace={trace} verified={verified} entities={entities} sources={sources} semanticState={semanticState} semanticProgress={semanticProgress} enableSemantic={enableSemantic} runEvidence={runEvidence} runLocalLlm={runLocalLlm} llmProgress={llmProgress} />}
        {view === "canvas" && <CanvasStudio canvases={canvases} notes={notes} selected={selected} refresh={refresh} />}
        {view === "library" && <LibraryStudio notes={notes} graph={authoredGraph} documents={documents} entities={entities} relations={relations} views={views} trash={trash} snapshots={snapshots} queryTraces={queryTraces} reviewAudit={reviewAudit} restoreTrash={restoreTrash} restoreSnapshot={restoreSnapshot} openNote={openNote} refresh={refresh} />}
      </main>

      <footer className="statusbar">
        <span>{status}</span>
        <span>{sources.length} source blocks · {entities.filter((item) => item.status === "accepted" && !item.mergedIntoId).length} accepted entities · {relations.filter((item) => item.status === "accepted").length} accepted relations · {queryTraces.length} traces</span>
      </footer>
    </div>
  );
}

function WorkspaceView({ note, notes, graph, mode, setMode, save, rename, remove, openNote }: {
  note?: NoteRecord;
  notes: NoteRecord[];
  graph: KnowledgeGraph;
  mode: NoteMode;
  setMode: (mode: NoteMode) => void;
  save: (markdown: string) => void;
  rename: () => void;
  remove: () => void;
  openNote: (id: string) => void;
}) {
  if (!note) return <div className="empty-state"><h1>Own your knowledge.</h1><p>Create a note or import evidence to begin.</p></div>;
  const parsed = parseMarkdown(note.markdown);
  const backlinks = backlinksFor(note.id, graph, notes);
  return (
    <div className="note-workspace">
      <section className="document-pane">
        <div className="document-header">
          <div><span className="eyebrow">{note.path}</span><h1>{note.title}</h1></div>
          <div className="mode-switch">
            <button className={mode === "edit" ? "active" : ""} onClick={() => setMode("edit")}>Edit</button>
            <button className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")}>Preview</button>
            <button onClick={rename}>Rename</button>
            <button onClick={remove}>Trash</button>
          </div>
        </div>
        {mode === "edit"
          ? <textarea aria-label="Markdown editor" className="editor" value={note.markdown} onChange={(event) => void save(event.target.value)} />
          : <article className="preview prose" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(parsed.body, { async: false }) as string) }} />}
      </section>
      <aside className="inspector">
        <div className="panel"><div className="panel-title">Properties</div>{Object.entries(parsed.properties).map(([key, value]) => <div className="property" key={key}><span>{key}</span><code>{Array.isArray(value) ? value.join(", ") : String(value)}</code></div>)}</div>
        <div className="panel"><div className="panel-title">Links <span>{parsed.links.length}</span></div>{parsed.links.map((link, index) => <div className="link-chip" key={`${link.raw}-${index}`}>→ {link.target}</div>)}</div>
        <div className="panel"><div className="panel-title">Backlinks <span>{backlinks.length}</span></div>{backlinks.map((item) => <button className="inspector-link" key={item.id} onClick={() => openNote(item.id)}>← {item.title}</button>)}</div>
      </aside>
    </div>
  );
}

function DocumentsView({ documents, blocks, importKnowledge }: {
  documents: SourceDocumentRecord[];
  blocks: DocumentBlockRecord[];
  importKnowledge: (files: FileList | null) => Promise<void>;
}) {
  return (
    <div className="single-view">
      <span className="eyebrow">Document intelligence</span>
      <h1>Every extracted block keeps its source.</h1>
      <p className="lede">PDF pages, CSV rows, DOCX/HTML sections and text offsets are stored locally with content hashes and extractor versions.</p>
      <label className="primary import-hero">Import PDF / DOCX / CSV / HTML / text<input hidden type="file" multiple accept=".md,.txt,.csv,.html,.htm,.pdf,.docx" onChange={(event) => void importKnowledge(event.target.files)} /></label>
      <div className="document-grid">
        {documents.map((document) => {
          const sourceBlocks = blocks.filter((block) => block.documentId === document.id);
          return (
            <article className="document-card" key={document.id}>
              <div className="doc-kind">{document.format.toUpperCase()}</div>
              <h3>{document.name}</h3>
              <p>{sourceBlocks.length} blocks · {(document.size / 1024).toFixed(1)} KiB</p>
              <code>{document.sha256.slice(0, 20)}…</code>
              <small>{document.extractorVersion}</small>
              {sourceBlocks.slice(0, 3).map((block) => (
                <div className="source-mini" key={block.id}><strong>{formatLocation(block.location)}</strong><span>{block.text.slice(0, 130)}{block.text.length > 130 ? "…" : ""}</span></div>
              ))}
            </article>
          );
        })}
        {!documents.length && <div className="empty-evidence">No imported documents yet.</div>}
      </div>
    </div>
  );
}

function GraphStudio({ graph, entities, relations, onOpen }: {
  graph: KnowledgeGraph;
  entities: EntityCandidateRecord[];
  relations: RelationCandidateRecord[];
  onOpen: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const openRef = useRef(onOpen);
  useEffect(() => { openRef.current = onOpen; }, [onOpen]);
  const acceptedEntities = useMemo(() => entities.filter((item) => item.status === "accepted" && !item.mergedIntoId), [entities]);
  const acceptedRelations = useMemo(() => relations.filter((item) => item.status === "accepted"), [relations]);
  const components = useMemo(() => connectedComponents(entities, relations), [entities, relations]);

  useEffect(() => {
    let destroyed = false;
    let cleanup: (() => void) | undefined;
    void import("cytoscape").then(({ default: cytoscape }) => {
      if (destroyed || !ref.current) return;
      const cy = cytoscape({
        container: ref.current,
        elements: [
          ...graph.nodes.map((node) => ({ data: { id: `note:${node.id}`, label: node.title, kind: node.kind } })),
          ...graph.edges.map((edge) => ({ data: { id: `authored:${edge.id}`, source: `note:${edge.source}`, target: `note:${edge.target}`, layer: "authored" } })),
          ...acceptedEntities.map((entity) => ({ data: { id: `entity:${entity.id}`, label: entity.canonicalName, kind: "entity" } })),
          ...acceptedRelations.filter((relation) => acceptedEntities.some((entity) => entity.id === relation.sourceEntityId) && acceptedEntities.some((entity) => entity.id === relation.targetEntityId)).map((relation) => ({ data: { id: `inferred:${relation.id}`, source: `entity:${relation.sourceEntityId}`, target: `entity:${relation.targetEntityId}`, layer: "inferred", label: relation.relation } }))
        ],
        style: [
          { selector: "node", style: { "background-color": "#7c8cff", label: "data(label)", color: "#dfe4ef", "font-size": 10, "text-valign": "bottom", "text-margin-y": 7, width: 22, height: 22 } },
          { selector: 'node[kind = "entity"]', style: { "background-color": "#53cfa1", shape: "round-rectangle", width: 28, height: 18 } },
          { selector: 'node[kind = "unresolved"]', style: { "background-color": "#343b4b", "border-color": "#f4b860", "border-width": 2, "border-style": "dashed" } },
          { selector: "edge", style: { width: 1.2, "line-color": "#49536a", "target-arrow-color": "#49536a", "target-arrow-shape": "triangle", "curve-style": "bezier" } },
          { selector: 'edge[layer = "inferred"]', style: { "line-style": "dashed", "line-color": "#53cfa1", "target-arrow-color": "#53cfa1" } }
        ],
        layout: { name: "cose", animate: false, padding: 30 }
      });
      cy.on("tap", "node", (event) => {
        const id = event.target.id() as string;
        if (id.startsWith("note:")) openRef.current(id.slice(5));
      });
      cleanup = () => cy.destroy();
    });
    return () => { destroyed = true; cleanup?.(); };
  }, [graph, acceptedEntities, acceptedRelations]);

  return (
    <div className="single-view">
      <span className="eyebrow">Layered knowledge graph</span>
      <h1>Authored truth and reviewed inference stay distinct.</h1>
      <p className="lede">Purple nodes/solid edges are authored Markdown. Green nodes/dashed edges are reviewed inferred knowledge. Merged or rejected candidates are excluded.</p>
      <div className="legend"><span><i className="dot resolved"></i>Authored</span><span className="green-dot">● Accepted inferred</span><span>{acceptedRelations.length} reviewed inferred edges</span><span>{components.length} reviewed graph communities</span></div>
      <div ref={ref} className="graph-canvas graph-v1" />
    </div>
  );
}

function ReviewView({ entities, relations, blocks, audit, rebuild, reviewEntity, reviewRelation, renameEntity: renameEntityAction, togglePin, mergeEntity, splitEntity: splitEntityAction, undoAudit, runLocalNer, buildSemanticSuggestions, semanticSuggestions, reviewSemanticSuggestion }: {
  entities: EntityCandidateRecord[];
  relations: RelationCandidateRecord[];
  blocks: UnifiedSourceBlock[];
  audit: ReviewAuditRecord[];
  rebuild: () => Promise<void>;
  reviewEntity: (entity: EntityCandidateRecord, accepted: boolean) => Promise<void>;
  reviewRelation: (relation: RelationCandidateRecord, accepted: boolean) => Promise<void>;
  renameEntity: (entity: EntityCandidateRecord) => Promise<void>;
  togglePin: (entity: EntityCandidateRecord) => Promise<void>;
  mergeEntity: (entity: EntityCandidateRecord) => Promise<void>;
  splitEntity: (entity: EntityCandidateRecord) => Promise<void>;
  undoAudit: (id: string) => Promise<void>;
  runLocalNer: () => Promise<void>;
  buildSemanticSuggestions: () => Promise<void>;
  semanticSuggestions: SemanticLinkSuggestionRecord[];
  reviewSemanticSuggestion: (id: string, accepted: boolean) => Promise<void>;
}) {
  const [scope, setScope] = useState<"pending" | "reviewed">("pending");
  const visibleEntities = entities.filter((item) => !item.mergedIntoId && (scope === "pending" ? item.status === "pending" : item.status !== "pending"));
  const visibleRelations = relations.filter((item) => scope === "pending" ? item.status === "pending" : item.status !== "pending");
  const blockMap = new Map(blocks.map((block) => [block.id, block]));
  const entityMap = new Map(entities.map((entity) => [entity.id, entity]));
  return (
    <div className="single-view">
      <div className="hero-row">
        <div><span className="eyebrow">Human review queue</span><h1>Inference proposes. You decide.</h1><p>Every decision is auditable. Extractor-version changes reopen stale decisions rather than silently inheriting trust.</p></div>
        <div className="review-actions wrap-actions"><button className="primary" onClick={() => void rebuild()}>Rebuild deterministic</button><button onClick={() => void runLocalNer()}>Optional local NER</button><button onClick={() => void buildSemanticSuggestions()}>Suggest semantic links</button></div>
      </div>
      <div className="segmented compact-segmented"><button className={scope === "pending" ? "active" : ""} onClick={() => setScope("pending")}>Pending</button><button className={scope === "reviewed" ? "active" : ""} onClick={() => setScope("reviewed")}>Reviewed</button></div>
      <div className="review-columns">
        <section>
          <h2>Entities <span>{visibleEntities.length}</span></h2>
          {visibleEntities.slice(0, 100).map((entity) => (
            <article className={`review-card ${entity.pinned ? "pinned" : ""}`} key={entity.id}>
              <div className="review-title"><strong>{entity.pinned ? "★ " : ""}{entity.canonicalName}</strong><small>{entity.entityType} · {Math.round(entity.confidence * 100)}% · {entity.status}</small></div>
              <p>{entity.evidenceBlockIds.slice(0, 3).map((id) => blockMap.get(id)?.title).filter(Boolean).join(" · ")}</p>
              <div className="review-actions wrap-actions">
                {entity.status === "pending" && <><button onClick={() => void reviewEntity(entity, true)}>Accept</button><button onClick={() => void reviewEntity(entity, false)}>Reject</button></>}
                <button onClick={() => void renameEntityAction(entity)}>Rename</button>
                <button onClick={() => void togglePin(entity)}>{entity.pinned ? "Unpin" : "Pin"}</button>
                <button onClick={() => void mergeEntity(entity)}>Merge</button>
                <button disabled={entity.evidenceBlockIds.length < 2} onClick={() => void splitEntityAction(entity)}>Split</button>
              </div>
            </article>
          ))}
        </section>
        <section>
          <h2>Relationships <span>{visibleRelations.length}</span></h2>
          {visibleRelations.slice(0, 100).map((relation) => (
            <article className="review-card" key={relation.id}>
              <div><strong>{entityMap.get(relation.sourceEntityId)?.canonicalName ?? relation.sourceEntityId}</strong><small> {relation.relation} → </small><strong>{entityMap.get(relation.targetEntityId)?.canonicalName ?? relation.targetEntityId}</strong></div>
              <p>{relation.evidenceBlockIds.map((id) => blockMap.get(id)?.title).filter(Boolean).slice(0, 3).join(" · ")} · {Math.round(relation.confidence * 100)}% · {relation.status}</p>
              {relation.status === "pending" && <div className="review-actions"><button onClick={() => void reviewRelation(relation, true)}>Accept</button><button onClick={() => void reviewRelation(relation, false)}>Reject</button></div>}
            </article>
          ))}
          <h2>Semantic suggestions <span>{semanticSuggestions.length}</span></h2>
          {semanticSuggestions.slice(0, 30).map((suggestion) => <article className="review-card" key={suggestion.id}><div><strong>{entityMap.get(suggestion.sourceEntityId)?.canonicalName ?? suggestion.sourceEntityId}</strong><small> ⇄ semantic · {Math.round(suggestion.score * 100)}% ⇄ </small><strong>{entityMap.get(suggestion.targetEntityId)?.canonicalName ?? suggestion.targetEntityId}</strong></div><p>{suggestion.status} · {suggestion.modelId}</p>{suggestion.status === "pending" && <div className="review-actions"><button onClick={() => void reviewSemanticSuggestion(suggestion.id, true)}>Accept suggestion</button><button onClick={() => void reviewSemanticSuggestion(suggestion.id, false)}>Reject suggestion</button></div>}</article>)}
          <h2>Recent audit <span>{audit.length}</span></h2>
          <div className="audit-list">{audit.slice(0, 20).map((item) => <div className="audit-row" key={item.id}><strong>{item.action}</strong><span>{item.targetKind} · {item.targetId.slice(0, 28)}</span><time>{new Date(item.createdAt).toLocaleString()}</time>{item.action !== "undo" && item.beforeJson && <button onClick={() => void undoAudit(item.id)}>Undo</button>}</div>)}</div>
        </section>
      </div>
    </div>
  );
}

function EvidenceStudio({ question, setQuestion, evidence, trace, verified, entities, sources, semanticState, semanticProgress, enableSemantic, runEvidence, runLocalLlm, llmProgress }: {
  question: string;
  setQuestion: (value: string) => void;
  evidence: RankedEvidence[];
  trace?: EvidenceQueryTrace;
  verified?: VerifiedAnswer;
  entities: EntityCandidateRecord[];
  sources: UnifiedSourceBlock[];
  semanticState: SemanticState;
  semanticProgress: string;
  enableSemantic: () => Promise<void>;
  runEvidence: () => Promise<void>;
  runLocalLlm: () => Promise<void>;
  llmProgress: string;
}) {
  const entityMap = new Map(entities.map((entity) => [entity.id, entity]));
  const blockMap = new Map(sources.map((block) => [block.id, block]));
  return (
    <div className="single-view evidence-view">
      <span className="eyebrow">Hybrid GraphRAG + verification</span>
      <h1>Verify every answer.</h1>
      <p className="lede">BM25 is always local. Optional embeddings run in-browser and persist by model/content hash. Reviewed graph paths and temporal constraints are fused with lexical/vector evidence through RRF.</p>
      <div className="ask-box"><input aria-label="Evidence question" value={question} onChange={(event) => setQuestion(event.target.value)} /><button className="primary" onClick={() => void runEvidence()}>Retrieve</button></div>
      <div className="engine-controls">
        <button onClick={() => void enableSemantic()} disabled={semanticState === "loading" || semanticState === "ready"}>{semanticState === "ready" ? "Semantic ready" : semanticState === "loading" ? "Loading semantic…" : "Enable local semantic"}</button>
        <button onClick={() => void runLocalLlm()} disabled={!evidence.length && !question.trim()}>Generate with local WebLLM</button>
        {trace && <button onClick={() => download(`evidenceweave-trace-${trace.id}.json`, JSON.stringify(trace, null, 2))}>Download trace</button>}
        <span>{semanticProgress || llmProgress}</span>
      </div>
      {trace && (
        <section className="trace-proof">
          <div className="trace-head"><strong>Route: {trace.route.mode}</strong><span>{trace.retrievalVersion}</span><time>{new Date(trace.createdAt).toLocaleString()}</time></div>
          <p>{trace.route.reason}</p>
          {trace.route.temporal && <div className="trace-chip">Temporal window: {trace.route.temporal.fromYear ?? "…"} → {trace.route.temporal.toYear ?? "…"}</div>}
          <div className="trace-stats"><span>{trace.diagnostics.blockCount} blocks</span><span>{trace.diagnostics.acceptedEntityCount} accepted entities</span><span>{trace.diagnostics.acceptedRelationCount} accepted relations</span><span>{trace.components.length} communities</span><span>{trace.diagnostics.semanticEnabled ? "semantic on" : "semantic off"}</span></div>
          {trace.paths.map((path, index) => (
            <div className="path-proof" key={`${path.sourceEntityId}-${path.targetEntityId}-${index}`}>
              <strong>{entityMap.get(path.sourceEntityId)?.canonicalName ?? path.sourceEntityId} ⇄ {entityMap.get(path.targetEntityId)?.canonicalName ?? path.targetEntityId}</strong>
              {path.hops.map((hop) => <div className="path-hop" key={hop.relationId}><span>{entityMap.get(hop.fromEntityId)?.canonicalName ?? hop.fromEntityId}</span><b> —{hop.relation}→ </b><span>{entityMap.get(hop.toEntityId)?.canonicalName ?? hop.toEntityId}</span><small>{hop.evidenceBlockIds.map((id) => blockMap.get(id)?.title ?? id).join(" · ")}</small></div>)}
            </div>
          ))}
          {trace.diagnostics.missingPathPairs.length > 0 && <div className="claim-warning">Missing reviewed graph paths: {trace.diagnostics.missingPathPairs.join(", ")}. EvidenceWeave does not invent the missing hops.</div>}
        </section>
      )}
      {verified && (
        <section className="answer-proof">
          <div className="answer-head"><strong>{verified.mode === "webllm" ? "Local generated answer" : "Extractive evidence answer"}</strong><span className={verified.coverage >= 0.8 ? "coverage good" : "coverage warn"}>{Math.round(verified.coverage * 100)}% claim coverage</span></div>
          <p>{verified.answer}</p>
          {verified.claims.some((claim) => !claim.supported) && <div className="claim-warning">Unsupported or weakly supported claims are flagged rather than silently treated as verified.</div>}
        </section>
      )}
      <div className="evidence-list">
        {evidence.map((hit, index) => (
          <article className="evidence-card" key={hit.block.id}>
            <div className="evidence-head"><span>S{index + 1}</span><button>{hit.block.title}</button><strong>RRF {hit.fusedScore.toFixed(4)}</strong></div>
            <p>{hit.block.text}</p>
            <div className="rank-grid"><code>BM25 #{hit.ranks.bm25 ?? "–"}</code><code>Vector #{hit.ranks.vector ?? "–"}</code><code>Graph #{hit.ranks.graph ?? "–"}</code><code>{hit.block.page ? `page ${hit.block.page}` : hit.block.row ? `row ${hit.block.row}` : hit.block.startOffset !== undefined ? `chars ${hit.block.startOffset}–${hit.block.endOffset}` : "source block"}</code></div>
          </article>
        ))}
      </div>
      {!evidence.length && <div className="empty-evidence">Run retrieval. If the workspace cannot support the question, EvidenceWeave will fail closed.</div>}
    </div>
  );
}

function CanvasStudio({ canvases, notes, selected, refresh }: {
  canvases: CanvasRecord[];
  notes: NoteRecord[];
  selected?: NoteRecord;
  refresh: () => Promise<void>;
}) {
  const [activeId, setActiveId] = useState(canvases[0]?.id ?? "");
  useEffect(() => {
    if (!activeId && canvases[0]) setActiveId(canvases[0].id);
    if (activeId && !canvases.some((item) => item.id === activeId)) setActiveId(canvases[0]?.id ?? "");
  }, [canvases, activeId]);
  const canvas = canvases.find((item) => item.id === activeId);

  const ensureCanvas = async () => {
    const next = createCanvas();
    await knowledgeDb.canvases.put(next);
    setActiveId(next.id);
    await refresh();
  };

  const addSelected = async () => {
    if (!selected) return;
    let current = canvas;
    if (!current) {
      current = createCanvas();
      await knowledgeDb.canvases.put(current);
      setActiveId(current.id);
    }
    const next = addCanvasNode(current, { kind: "note", refId: selected.id, label: selected.title, x: 80 + current.nodes.length * 35, y: 70 + current.nodes.length * 25, width: 190, height: 90 });
    await knowledgeDb.canvases.put(next);
    await refresh();
  };

  const addLabel = async () => {
    if (!canvas) return;
    const label = prompt("Canvas label", "Idea")?.trim();
    if (!label) return;
    await knowledgeDb.canvases.put(addCanvasNode(canvas, { kind: "label", label, x: 120 + canvas.nodes.length * 28, y: 120 + canvas.nodes.length * 20, width: 160, height: 70 }));
    await refresh();
  };

  const connectLastTwo = async () => {
    if (!canvas || canvas.nodes.length < 2) return;
    const nodes = canvas.nodes.filter((node) => node.kind !== "group");
    if (nodes.length < 2) return;
    const [source, target] = nodes.slice(-2);
    await knowledgeDb.canvases.put(addCanvasEdge(canvas, source.id, target.id, "related"));
    await refresh();
  };

  const groupAll = async () => {
    if (!canvas) return;
    const ids = canvas.nodes.filter((node) => node.kind !== "group").map((node) => node.id);
    if (!ids.length) return;
    const label = prompt("Group label", "Cluster") ?? "Cluster";
    await knowledgeDb.canvases.put(assignCanvasGroup(canvas, ids, label));
    await refresh();
  };

  const resizeLast = async () => {
    if (!canvas) return;
    const node = [...canvas.nodes].reverse().find((item) => item.kind !== "group");
    if (!node) return;
    await knowledgeDb.canvases.put(resizeCanvasNode(canvas, node.id, node.width + 40, node.height + 25));
    await refresh();
  };

  const removeLast = async () => {
    if (!canvas) return;
    const node = [...canvas.nodes].reverse().find((item) => item.kind !== "group");
    if (!node) return;
    await knowledgeDb.canvases.put(removeCanvasNode(canvas, node.id));
    await refresh();
  };

  const move = async (nodeId: string, x: number, y: number) => {
    if (!canvas) return;
    await knowledgeDb.canvases.put(moveCanvasNode(canvas, nodeId, x, y));
    await refresh();
  };

  const exportActive = () => {
    if (canvas) download(`${canvas.title.replace(/\s+/g, "-").toLocaleLowerCase()}.evidenceweave-canvas.json`, exportCanvas(canvas));
  };

  const importOne = async (file?: File) => {
    if (!file) return;
    const imported = importCanvas(await file.text());
    await knowledgeDb.canvases.put({ ...imported, id: crypto.randomUUID(), title: `${imported.title} (imported)`, updatedAt: stamp() });
    await refresh();
  };

  return (
    <div className="single-view canvas-view">
      <div className="hero-row">
        <div><span className="eyebrow">Open local canvas</span><h1>Arrange knowledge spatially.</h1><p>Canvas metadata is local/exportable and never replaces the underlying Markdown.</p></div>
        <div className="canvas-actions"><button onClick={() => void ensureCanvas()}>New canvas</button><button className="primary" onClick={() => void addSelected()} disabled={!selected}>Add current note</button><button onClick={() => void addLabel()} disabled={!canvas}>Add label</button><button onClick={() => void connectLastTwo()} disabled={!canvas}>Connect last two</button><button onClick={() => void groupAll()} disabled={!canvas}>Group</button><button onClick={() => void resizeLast()} disabled={!canvas}>Resize last</button><button onClick={() => void removeLast()} disabled={!canvas}>Remove last</button><button onClick={exportActive} disabled={!canvas}>Export</button><label className="canvas-file">Import<input hidden type="file" accept=".json,application/json" onChange={(event) => void importOne(event.target.files?.[0])} /></label></div>
      </div>
      <div className="canvas-tabs">{canvases.map((item) => <button className={item.id === activeId ? "active" : ""} key={item.id} onClick={() => setActiveId(item.id)}>{item.title}</button>)}</div>
      <div className="infinite-canvas">
        {canvas?.edges.map((edge) => <div className="canvas-edge-label" key={edge.id}>{edge.label ?? "link"}</div>)}
        {canvas?.nodes.map((node) => (
          <article
            className={`canvas-node ${node.kind === "group" ? "canvas-group" : ""}`}
            key={node.id}
            style={{ left: node.x, top: node.y, width: node.width, minHeight: node.height }}
            draggable={node.kind !== "group"}
            onDragEnd={(event) => {
              const parent = event.currentTarget.parentElement?.getBoundingClientRect();
              if (!parent) return;
              void move(node.id, Math.max(0, event.clientX - parent.left - node.width / 2), Math.max(0, event.clientY - parent.top - 20));
            }}
          >
            <strong>{node.label}</strong><small>{node.kind}{node.refId && notes.some((note) => note.id === node.refId) ? " · linked" : ""}{node.groupId ? " · grouped" : ""}</small>
          </article>
        ))}
      </div>
    </div>
  );
}

function LibraryStudio({ notes, graph, documents, entities, relations, views, trash, snapshots, queryTraces, reviewAudit, restoreTrash, restoreSnapshot, openNote, refresh }: {
  notes: NoteRecord[];
  graph: KnowledgeGraph;
  documents: SourceDocumentRecord[];
  entities: EntityCandidateRecord[];
  relations: RelationCandidateRecord[];
  views: SavedViewRecord[];
  trash: TrashRecord[];
  snapshots: SnapshotRecord[];
  queryTraces: QueryTraceRecord[];
  reviewAudit: ReviewAuditRecord[];
  restoreTrash: (id: string) => Promise<void>;
  restoreSnapshot: (id: string) => Promise<void>;
  openNote: (id: string) => void;
  refresh: () => Promise<void>;
}) {
  const [activeViewId, setActiveViewId] = useState(views[0]?.id ?? "");
  useEffect(() => {
    if (!activeViewId && views[0]) setActiveViewId(views[0].id);
    if (activeViewId && !views.some((item) => item.id === activeViewId)) setActiveViewId(views[0]?.id ?? "");
  }, [views, activeViewId]);
  const activeView = views.find((item) => item.id === activeViewId);
  const groups = activeView ? groupNotesForView(notes, activeView) : new Map([["All", notes]]);

  const addView = async (mode: SavedViewRecord["mode"]) => {
    const title = prompt(`${mode} view name`, `${mode[0].toUpperCase() + mode.slice(1)} view`)?.trim();
    if (!title) return;
    const groupBy = mode === "kanban" ? prompt("Frontmatter property to group by", "status")?.trim() : undefined;
    const next = createSavedView(title, mode, groupBy);
    await knowledgeDb.views.put(next);
    setActiveViewId(next.id);
    await refresh();
  };

  const addFilter = async () => {
    if (!activeView) return;
    const property = prompt("Frontmatter property to filter")?.trim();
    if (!property) return;
    const value = prompt("Value contains", "") ?? "";
    await knowledgeDb.views.put({ ...activeView, filters: [...activeView.filters, { property, operator: "contains", value }], updatedAt: stamp() });
    await refresh();
  };

  return (
    <div className="single-view">
      <span className="eyebrow">Knowledge library</span>
      <h1>Structured, recoverable, portable.</h1>
      <div className="metric-row"><div><strong>{notes.length}</strong><span>Notes</span></div><div><strong>{documents.length}</strong><span>Documents</span></div><div><strong>{graph.edges.filter((edge) => edge.resolved).length}</strong><span>Authored links</span></div><div><strong>{relations.filter((item) => item.status === "accepted").length}</strong><span>Accepted relations</span></div><div><strong>{queryTraces.length}</strong><span>Query traces</span></div><div><strong>{reviewAudit.length}</strong><span>Audit events</span></div></div>
      <div className="view-toolbar"><span>Saved views</span>{views.map((item) => <button className={item.id === activeViewId ? "active" : ""} key={item.id} onClick={() => setActiveViewId(item.id)}>{item.title}</button>)}<button onClick={() => void addView("table")}>+ Table</button><button onClick={() => void addView("cards")}>+ Cards</button><button onClick={() => void addView("list")}>+ List</button><button onClick={() => void addView("kanban")}>+ Kanban</button>{activeView && <button onClick={() => void addFilter()}>+ Filter</button>}</div>
      <div className={`saved-view-display mode-${activeView?.mode ?? "list"}`}>
        {[...groups.entries()].map(([group, groupNotes]) => <section className="view-group" key={group}><h3>{group} <span>{groupNotes.length}</span></h3><div className="view-group-items">{groupNotes.map((note) => <button className="library-row" key={note.id} onClick={() => openNote(note.id)}><strong>{note.title}</strong><span>{note.path}</span></button>)}</div></section>)}
      </div>
      <div className="library-split">
        <section><h2>Local trash <span>{trash.length}</span></h2>{trash.map((item) => <div className="trash-row" key={item.id}><span>{item.kind} · {new Date(item.deletedAt).toLocaleString()}</span>{item.kind === "note" && <button onClick={() => void restoreTrash(item.id)}>Restore</button>}</div>)}<h2>Snapshots <span>{snapshots.length}</span></h2>{snapshots.slice(0, 15).map((item) => <div className="trash-row" key={item.id}><span>{item.label}<br />{new Date(item.createdAt).toLocaleString()}</span><button onClick={() => void restoreSnapshot(item.id)}>Restore snapshot</button></div>)}</section>
        <section><h2>Reviewed knowledge</h2><p className="muted">{entities.filter((item) => item.status === "accepted" && !item.mergedIntoId).length} accepted entities · {entities.filter((item) => item.status === "rejected").length} rejected entities · {entities.filter((item) => item.pinned).length} pinned.</p><h2>Recent query traces</h2>{queryTraces.slice(0, 12).map((item) => <div className="trace-list-row" key={item.id}><strong>{item.mode}</strong><span>{item.question}</span><time>{new Date(item.createdAt).toLocaleString()}</time><button onClick={() => download(`evidenceweave-trace-${item.id}.json`, item.payload)}>JSON</button></div>)}</section>
      </div>
    </div>
  );
}
