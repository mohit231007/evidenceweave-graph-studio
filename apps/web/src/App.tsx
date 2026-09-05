import { useEffect, useMemo, useRef, useState } from "react";
import cytoscape from "cytoscape";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { backlinksFor, buildAuthoredGraph, db, exportWorkspace, extractiveEvidenceSearch, importWorkspace, parseMarkdown, seedIfEmpty, validateWorkspaceExport, type EvidenceHit, type NoteRecord } from "./lib/core";

type MainView = "note" | "graph" | "evidence";
type NoteMode = "edit" | "preview";

const download = (name: string, content: string, type: string) => {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = name; anchor.click();
  URL.revokeObjectURL(url);
};

function App() {
  const [notes, setNotes] = useState<NoteRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<MainView>("note");
  const [mode, setMode] = useState<NoteMode>("edit");
  const [answerQuery, setAnswerQuery] = useState("What does EvidenceWeave say about provenance?");
  const [evidence, setEvidence] = useState<EvidenceHit[]>([]);
  const [status, setStatus] = useState("Local-first · no account · no API key");

  const refresh = async (preferId?: string) => {
    const next = await db.notes.orderBy("updatedAt").reverse().toArray();
    setNotes(next);
    setSelectedId((current) => (preferId ?? current) || next[0]?.id || "");
  };

  useEffect(() => { void seedIfEmpty().then(() => refresh()); }, []);

  const selected = notes.find((note) => note.id === selectedId);
  const graph = useMemo(() => buildAuthoredGraph(notes), [notes]);
  const backlinks = selected ? backlinksFor(selected.id, graph, notes) : [];
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return notes;
    return notes.filter((note) => `${note.title}\n${note.markdown}`.toLowerCase().includes(needle));
  }, [notes, query]);

  const saveSelected = async (markdown: string) => {
    if (!selected) return;
    const firstHeading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
    const title = firstHeading || selected.title;
    const updated = { ...selected, title, path: `${title.replace(/[\\/:*?\"<>|]/g, "-")}.md`, markdown, updatedAt: new Date().toISOString() };
    await db.notes.put(updated);
    setNotes((current) => current.map((note) => note.id === updated.id ? updated : note));
  };

  const createNote = async () => {
    const id = crypto.randomUUID();
    const stamp = new Date().toISOString();
    const note: NoteRecord = { id, title: "Untitled", path: `Untitled-${id.slice(0, 6)}.md`, markdown: "# Untitled\n\nStart writing. Link another note with [[Note Title]].", createdAt: stamp, updatedAt: stamp };
    await db.notes.add(note); await refresh(id); setView("note"); setMode("edit");
  };

  const removeNote = async () => {
    if (!selected || !confirm(`Move “${selected.title}” out of this local workspace?`)) return;
    await db.notes.delete(selected.id); await refresh();
  };

  const importFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (file.name.toLowerCase().endsWith(".md") || file.name.toLowerCase().endsWith(".txt")) {
        const markdown = await file.text();
        const stamp = new Date().toISOString();
        const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || file.name.replace(/\.[^.]+$/, "");
        await db.notes.put({ id: crypto.randomUUID(), title, path: file.name, markdown, createdAt: stamp, updatedAt: stamp });
      }
    }
    await refresh(); setStatus("Imported local Markdown/TXT files. Nothing was uploaded to an app server.");
  };

  const exportAll = async () => {
    const payload = await exportWorkspace(notes);
    download(`evidenceweave-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2), "application/json");
  };

  const importExport = async (file?: File) => {
    if (!file) return;
    try {
      const payload = validateWorkspaceExport(JSON.parse(await file.text()));
      await importWorkspace(payload); await refresh(); setStatus(`Restored ${payload.notes.length} notes from a portable export.`);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Import failed."); }
  };

  const runEvidence = () => {
    const hits = extractiveEvidenceSearch(answerQuery, notes, graph, 5);
    setEvidence(hits); setView("evidence");
    setStatus(hits.length ? `Found ${hits.length} inspectable local evidence matches.` : "Evidence gap: no local note matched enough query terms.");
  };

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand-mark">EW</div>
      <div className="brand-copy"><strong>EvidenceWeave</strong><span>Graph Studio</span></div>
      <nav className="view-tabs" aria-label="Primary views">
        <button className={view === "note" ? "active" : ""} onClick={() => setView("note")}>Workspace</button>
        <button className={view === "graph" ? "active" : ""} onClick={() => setView("graph")}>Graph</button>
        <button className={view === "evidence" ? "active" : ""} onClick={() => setView("evidence")}>Evidence</button>
      </nav>
      <div className="local-badge"><span></span> LOCAL</div>
    </header>

    <aside className="sidebar">
      <div className="sidebar-actions"><button className="primary" onClick={createNote}>+ New note</button></div>
      <label className="search"><span>⌕</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search local notes" /></label>
      <div className="section-label">Knowledge workspace <span>{notes.length}</span></div>
      <div className="note-list">
        {filtered.map((note) => <button key={note.id} className={note.id === selectedId ? "note-row active" : "note-row"} onClick={() => { setSelectedId(note.id); setView("note"); }}>
          <strong>{note.title}</strong><small>{parseMarkdown(note.markdown).tags.slice(0, 2).map((tag) => `#${tag}`).join(" · ") || "Markdown note"}</small>
        </button>)}
      </div>
      <div className="sidebar-footer">
        <label className="file-action">Import .md/.txt<input hidden type="file" multiple accept=".md,.txt,text/markdown,text/plain" onChange={(e) => void importFiles(e.target.files)} /></label>
        <button className="file-action" onClick={() => void exportAll()}>Export workspace</button>
        <label className="file-action">Restore export<input hidden type="file" accept="application/json,.json" onChange={(e) => void importExport(e.target.files?.[0])} /></label>
      </div>
    </aside>

    <main className="main-pane">
      {view === "note" && <NoteWorkspace note={selected} mode={mode} setMode={setMode} onChange={saveSelected} onDelete={removeNote} backlinks={backlinks} />}
      {view === "graph" && <GraphView notes={notes} graph={graph} onSelect={(id) => { if (!id.startsWith("unresolved:")) { setSelectedId(id); setView("note"); } }} />}
      {view === "evidence" && <EvidenceView query={answerQuery} setQuery={setAnswerQuery} run={runEvidence} evidence={evidence} onOpen={(id) => { setSelectedId(id); setView("note"); }} />}
    </main>

    <footer className="statusbar"><span>{status}</span><span>IndexedDB · authored graph · deterministic evidence</span></footer>
  </div>;
}

function NoteWorkspace({ note, mode, setMode, onChange, onDelete, backlinks }: { note?: NoteRecord; mode: NoteMode; setMode: (m: NoteMode) => void; onChange: (v: string) => void; onDelete: () => void; backlinks: NoteRecord[] }) {
  if (!note) return <div className="empty-state"><h1>Own your knowledge.</h1><p>Create or import a note to begin weaving connections.</p></div>;
  const parsed = parseMarkdown(note.markdown);
  return <div className="note-workspace">
    <section className="document-pane">
      <div className="document-header"><div><span className="eyebrow">{note.path}</span><h1>{note.title}</h1></div><div className="mode-switch"><button className={mode === "edit" ? "active" : ""} onClick={() => setMode("edit")}>Edit</button><button className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")}>Preview</button><button onClick={onDelete} title="Delete local note">Delete</button></div></div>
      {mode === "edit" ? <textarea className="editor" value={note.markdown} spellCheck onChange={(e) => onChange(e.target.value)} aria-label="Markdown editor" /> : <MarkdownPreview markdown={note.markdown} />}
    </section>
    <aside className="inspector">
      <div className="panel"><div className="panel-title">Properties</div>{Object.keys(parsed.properties).length ? Object.entries(parsed.properties).map(([k,v]) => <div className="property" key={k}><span>{k}</span><code>{Array.isArray(v) ? v.join(", ") : String(v)}</code></div>) : <p className="muted">Add YAML frontmatter to type this note.</p>}</div>
      <div className="panel"><div className="panel-title">Outgoing links <span>{parsed.links.length}</span></div>{parsed.links.map((link, i) => <div className="link-chip" key={`${link.raw}-${i}`}>→ {link.target}{link.heading ? ` / ${link.heading}` : ""}</div>)}</div>
      <div className="panel"><div className="panel-title">Backlinks <span>{backlinks.length}</span></div>{backlinks.length ? backlinks.map((item) => <div className="link-chip" key={item.id}>← {item.title}</div>) : <p className="muted">No notes link here yet.</p>}</div>
    </aside>
  </div>;
}

function MarkdownPreview({ markdown }: { markdown: string }) {
  const parsed = parseMarkdown(markdown);
  const safe = DOMPurify.sanitize(marked.parse(parsed.body, { async: false }) as string);
  return <article className="preview prose" dangerouslySetInnerHTML={{ __html: safe }} />;
}

function GraphView({ notes, graph, onSelect }: { notes: NoteRecord[]; graph: ReturnType<typeof buildAuthoredGraph>; onSelect: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const cy = cytoscape({ container: ref.current, elements: [...graph.nodes.map((node) => ({ data: { id: node.id, label: node.title, kind: node.kind } })), ...graph.edges.map((edge) => ({ data: { id: edge.id, source: edge.source, target: edge.target, resolved: edge.resolved } }))], style: [
      { selector: "node", style: { "background-color": "#7c8cff", label: "data(label)", color: "#dfe4ef", "font-size": 11, "text-valign": "bottom", "text-margin-y": 8, width: 22, height: 22 } },
      { selector: 'node[kind = "unresolved"]', style: { "background-color": "#343b4b", "border-color": "#f4b860", "border-width": 2, "border-style": "dashed" } },
      { selector: "edge", style: { width: 1.2, "line-color": "#49536a", "target-arrow-color": "#49536a", "target-arrow-shape": "triangle", "curve-style": "bezier" } }
    ], layout: { name: "cose", animate: false, fit: true, padding: 40 } });
    cy.on("tap", "node", (event) => onSelect(event.target.id()));
    return () => cy.destroy();
  }, [graph, onSelect]);
  return <div className="single-view"><div className="hero-row"><div><span className="eyebrow">Authored knowledge graph</span><h1>Connections you can inspect.</h1><p>{notes.length} notes · {graph.edges.length} authored links · {graph.nodes.filter((n) => n.kind === "unresolved").length} unresolved targets</p></div><div className="legend"><span><i className="dot resolved"></i>Resolved note</span><span><i className="dot unresolved"></i>Unresolved link</span></div></div><div ref={ref} className="graph-canvas" /></div>;
}

function EvidenceView({ query, setQuery, run, evidence, onOpen }: { query: string; setQuery: (v: string) => void; run: () => void; evidence: EvidenceHit[]; onOpen: (id: string) => void }) {
  return <div className="single-view evidence-view"><span className="eyebrow">Universal fallback · deterministic · local</span><h1>Verify before generation.</h1><p className="lede">This foundation does not pretend to have GraphRAG generation yet. It first proves a no-API evidence path: query local notes, rank inspectable source excerpts, and expose an evidence gap when nothing matches.</p><div className="ask-box"><input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} /><button className="primary" onClick={run}>Find evidence</button></div><div className="evidence-list">{evidence.map((hit, index) => <article className="evidence-card" key={hit.noteId}><div className="evidence-head"><span>S{index + 1}</span><button onClick={() => onOpen(hit.noteId)}>{hit.title}</button><strong>{Math.round(hit.score * 100)}%</strong></div><p>{hit.excerpt}</p><small>Matched: {hit.matchedTerms.join(", ")}</small></article>)}{!evidence.length && <div className="empty-evidence">Run a query to inspect the local evidence trail.</div>}</div></div>;
}

export default App;
