import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import {
  backlinksFor,
  buildAuthoredGraph,
  db,
  exportWorkspace,
  importWorkspace,
  localNeighborhood,
  makeUniqueTitle,
  MAX_TEXT_IMPORT_BYTES,
  MAX_WORKSPACE_EXPORT_BYTES,
  parseMarkdown,
  rewriteWikiLinkTarget,
  seedIfEmpty,
  validateWorkspaceExport,
  type KnowledgeGraph,
  type NoteRecord
} from "./lib/core";
import {
  planGraphEvidence,
  propertyColumns,
  unlinkedMentionsFor,
  type GraphQueryTrace,
  type MentionHit
} from "./lib/knowledge";

type MainView = "note" | "graph" | "library" | "evidence";
type NoteMode = "edit" | "preview";

const download = (name: string, content: string, type: string) => {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
};

const safePath = (title: string) => `${title.replace(/[\\/:*?\"<>|]/g, "-")}.md`;

function App() {
  const [notes, setNotes] = useState<NoteRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<MainView>("note");
  const [mode, setMode] = useState<NoteMode>("edit");
  const [answerQuery, setAnswerQuery] = useState("How are Welcome and GraphRAG connected, and what does the workspace say about provenance?");
  const [queryTrace, setQueryTrace] = useState<GraphQueryTrace>();
  const [status, setStatus] = useState("Local-first · no account · no API key");

  const refresh = async (preferId?: string) => {
    const next = await db.notes.orderBy("updatedAt").reverse().toArray();
    setNotes(next);
    setSelectedId((current) => {
      if (preferId && next.some((note) => note.id === preferId)) return preferId;
      if (current && next.some((note) => note.id === current)) return current;
      return next[0]?.id ?? "";
    });
  };

  useEffect(() => {
    void seedIfEmpty().then(() => refresh());
  }, []);

  const selected = notes.find((note) => note.id === selectedId);
  const graph = useMemo(() => buildAuthoredGraph(notes), [notes]);
  const backlinks = selected ? backlinksFor(selected.id, graph, notes) : [];
  const unlinkedMentions = useMemo(
    () => selected ? unlinkedMentionsFor(selected, notes) : [],
    [selected, notes]
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return notes;
    return notes.filter((note) => `${note.title}\n${note.markdown}`.toLowerCase().includes(needle));
  }, [notes, query]);

  const openNote = (id: string) => {
    if (!notes.some((note) => note.id === id)) return;
    setSelectedId(id);
    setView("note");
  };

  const saveSelected = async (markdown: string) => {
    if (!selected) return;
    const updated: NoteRecord = { ...selected, markdown, updatedAt: new Date().toISOString() };
    setNotes((current) => current.map((note) => note.id === updated.id ? updated : note));
    await db.notes.put(updated);
  };

  const renameSelected = async (requestedTitle: string) => {
    if (!selected) return;
    const desired = requestedTitle.trim();
    if (!desired || desired === selected.title) return;

    const title = makeUniqueTitle(desired, notes, selected.id);
    const stamp = new Date().toISOString();
    const firstHeading = selected.markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
    const renamedMarkdown = firstHeading === selected.title
      ? selected.markdown.replace(/^#\s+(.+)$/m, `# ${title}`)
      : selected.markdown;
    const renamed: NoteRecord = {
      ...selected,
      title,
      path: safePath(title),
      markdown: renamedMarkdown,
      updatedAt: stamp
    };

    const nextNotes = notes.map((note) => {
      const base = note.id === selected.id ? renamed : note;
      const rewritten = rewriteWikiLinkTarget(base.markdown, selected.title, title);
      return rewritten === base.markdown ? base : { ...base, markdown: rewritten, updatedAt: stamp };
    });

    setNotes(nextNotes);
    await db.transaction("rw", db.notes, async () => {
      await db.notes.bulkPut(nextNotes);
    });

    setStatus(
      title === desired
        ? `Renamed “${selected.title}” to “${title}” and preserved inbound wiki links.`
        : `“${desired}” already existed, so the note became “${title}”; inbound wiki links were preserved.`
    );
  };

  const createNote = async () => {
    const id = crypto.randomUUID();
    const stamp = new Date().toISOString();
    const title = makeUniqueTitle("Untitled", notes);
    const note: NoteRecord = {
      id,
      title,
      path: safePath(title),
      markdown: `# ${title}\n\nStart writing. Link another note with [[Note Title]].`,
      createdAt: stamp,
      updatedAt: stamp
    };
    await db.notes.add(note);
    await refresh(id);
    setView("note");
    setMode("edit");
  };

  const removeNote = async () => {
    if (!selected || !confirm(`Delete “${selected.title}” from this local workspace? Export first if you may need it later.`)) return;
    await db.notes.delete(selected.id);
    await refresh();
    setStatus(`Deleted “${selected.title}” locally. Trash/recovery snapshots are not shipped yet.`);
  };

  const importFiles = async (files: FileList | null) => {
    if (!files) return;
    const additions: NoteRecord[] = [];
    const working = [...notes];
    let skipped = 0;

    for (const file of Array.from(files)) {
      const supported = file.name.toLowerCase().endsWith(".md") || file.name.toLowerCase().endsWith(".txt");
      if (!supported || file.size > MAX_TEXT_IMPORT_BYTES) {
        skipped += 1;
        continue;
      }

      let markdown = await file.text();
      const stamp = new Date().toISOString();
      const requestedTitle = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || file.name.replace(/\.[^.]+$/, "");
      const title = makeUniqueTitle(requestedTitle, working);
      if (title !== requestedTitle && /^#\s+(.+)$/m.test(markdown)) {
        markdown = markdown.replace(/^#\s+(.+)$/m, `# ${title}`);
      }

      const note: NoteRecord = {
        id: crypto.randomUUID(),
        title,
        path: safePath(title),
        markdown,
        createdAt: stamp,
        updatedAt: stamp
      };
      additions.push(note);
      working.push(note);
    }

    if (additions.length) await db.notes.bulkPut(additions);
    await refresh(additions[0]?.id);
    setStatus(
      `Imported ${additions.length} local text note${additions.length === 1 ? "" : "s"}` +
      `${skipped ? `; skipped ${skipped} unsupported/oversized file${skipped === 1 ? "" : "s"}` : ""}. ` +
      "Nothing was uploaded to an app server."
    );
  };

  const exportAll = async () => {
    const payload = await exportWorkspace(notes);
    download(
      `evidenceweave-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(payload, null, 2),
      "application/json"
    );
  };

  const importExport = async (file?: File) => {
    if (!file) return;
    try {
      if (file.size > MAX_WORKSPACE_EXPORT_BYTES) {
        throw new Error("Workspace export exceeds the 5 MiB foundation safety limit.");
      }
      const payload = validateWorkspaceExport(JSON.parse(await file.text()));
      await importWorkspace(payload);
      await refresh(payload.notes[0]?.id);
      setStatus(`Restored ${payload.notes.length} notes from a portable export.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Import failed.");
    }
  };

  const runEvidence = () => {
    const trace = planGraphEvidence(answerQuery, notes, graph, selectedId, 5);
    setQueryTrace(trace);
    setView("evidence");
    setStatus(
      trace.evidence.length
        ? `${trace.mode}: found ${trace.evidence.length} evidence matches with inspectable authored-path contributions.`
        : "Evidence gap: the local workspace does not support this query strongly enough."
    );
  };

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand-mark">EW</div>
      <div className="brand-copy"><strong>EvidenceWeave</strong><span>Graph Studio</span></div>
      <nav className="view-tabs" aria-label="Primary views">
        <button className={view === "note" ? "active" : ""} onClick={() => setView("note")}>Workspace</button>
        <button className={view === "graph" ? "active" : ""} onClick={() => setView("graph")}>Graph</button>
        <button className={view === "library" ? "active" : ""} onClick={() => setView("library")}>Library</button>
        <button className={view === "evidence" ? "active" : ""} onClick={() => setView("evidence")}>Evidence</button>
      </nav>
      <div className="local-badge"><span></span> LOCAL</div>
    </header>

    <aside className="sidebar">
      <div className="sidebar-actions"><button className="primary" onClick={createNote}>+ New note</button></div>
      <label className="search">
        <span>⌕</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search local notes" />
      </label>
      <div className="section-label">Knowledge workspace <span>{notes.length}</span></div>
      <div className="note-list">
        {filtered.map((note) => <button
          key={note.id}
          className={note.id === selectedId ? "note-row active" : "note-row"}
          onClick={() => openNote(note.id)}
        >
          <strong>{note.title}</strong>
          <small>{parseMarkdown(note.markdown).tags.slice(0, 2).map((tag) => `#${tag}`).join(" · ") || "Markdown note"}</small>
        </button>)}
      </div>
      <div className="sidebar-footer">
        <label className="file-action">
          Import .md/.txt
          <input hidden type="file" multiple accept=".md,.txt,text/markdown,text/plain" onChange={(event) => void importFiles(event.target.files)} />
        </label>
        <button className="file-action" onClick={() => void exportAll()}>Export workspace</button>
        <label className="file-action">
          Restore export
          <input hidden type="file" accept="application/json,.json" onChange={(event) => void importExport(event.target.files?.[0])} />
        </label>
      </div>
    </aside>

    <main className="main-pane">
      {view === "note" && <NoteWorkspace
        note={selected}
        mode={mode}
        setMode={setMode}
        onChange={saveSelected}
        onRename={renameSelected}
        onDelete={removeNote}
        backlinks={backlinks}
        unlinkedMentions={unlinkedMentions}
        onOpen={openNote}
      />}
      {view === "graph" && <GraphView
        notes={notes}
        graph={graph}
        selectedId={selectedId}
        onSelect={openNote}
      />}
      {view === "library" && <LibraryView notes={notes} graph={graph} onOpen={openNote} />}
      {view === "evidence" && <EvidenceView
        query={answerQuery}
        setQuery={setAnswerQuery}
        run={runEvidence}
        trace={queryTrace}
        onOpen={openNote}
      />}
    </main>

    <footer className="statusbar">
      <span>{status}</span>
      <span>IndexedDB · authored graph · deterministic graph proof</span>
    </footer>
  </div>;
}

function NoteWorkspace({
  note,
  mode,
  setMode,
  onChange,
  onRename,
  onDelete,
  backlinks,
  unlinkedMentions,
  onOpen
}: {
  note?: NoteRecord;
  mode: NoteMode;
  setMode: (mode: NoteMode) => void;
  onChange: (value: string) => void;
  onRename: (title: string) => void;
  onDelete: () => void;
  backlinks: NoteRecord[];
  unlinkedMentions: MentionHit[];
  onOpen: (id: string) => void;
}) {
  if (!note) {
    return <div className="empty-state"><h1>Own your knowledge.</h1><p>Create or import a note to begin weaving connections.</p></div>;
  }

  const parsed = parseMarkdown(note.markdown);
  const requestRename = () => {
    const requested = prompt("Rename note", note.title)?.trim();
    if (requested && requested !== note.title) onRename(requested);
  };

  return <div className="note-workspace">
    <section className="document-pane">
      <div className="document-header">
        <div><span className="eyebrow">{note.path}</span><h1>{note.title}</h1></div>
        <div className="mode-switch">
          <button className={mode === "edit" ? "active" : ""} onClick={() => setMode("edit")}>Edit</button>
          <button className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")}>Preview</button>
          <button onClick={requestRename} title="Rename note and update inbound wiki links">Rename</button>
          <button onClick={onDelete} title="Delete local note">Delete</button>
        </div>
      </div>
      {mode === "edit"
        ? <textarea className="editor" value={note.markdown} spellCheck onChange={(event) => void onChange(event.target.value)} aria-label="Markdown editor" />
        : <MarkdownPreview markdown={note.markdown} />}
    </section>
    <aside className="inspector">
      <div className="panel">
        <div className="panel-title">Properties</div>
        {Object.keys(parsed.properties).length
          ? Object.entries(parsed.properties).map(([key, value]) => <div className="property" key={key}>
              <span>{key}</span><code>{Array.isArray(value) ? value.join(", ") : String(value)}</code>
            </div>)
          : <p className="muted">Add YAML frontmatter to type this note.</p>}
      </div>
      <div className="panel">
        <div className="panel-title">Outgoing links <span>{parsed.links.length}</span></div>
        {parsed.links.map((link, index) => <div className="link-chip" key={`${link.raw}-${index}`}>
          → {link.target}{link.heading ? ` / ${link.heading}` : ""}
        </div>)}
      </div>
      <div className="panel">
        <div className="panel-title">Backlinks <span>{backlinks.length}</span></div>
        {backlinks.length
          ? backlinks.map((item) => <button className="inspector-link" onClick={() => onOpen(item.id)} key={item.id}>← {item.title}</button>)
          : <p className="muted">No notes link here yet.</p>}
      </div>
      <div className="panel">
        <div className="panel-title">Unlinked mentions <span>{unlinkedMentions.length}</span></div>
        {unlinkedMentions.length
          ? unlinkedMentions.map((mention) => <button className="mention-card" key={mention.sourceNoteId} onClick={() => onOpen(mention.sourceNoteId)}>
              <strong>{mention.sourceTitle}</strong><span>{mention.excerpt}</span>
            </button>)
          : <p className="muted">No plain-text mentions waiting to be linked.</p>}
      </div>
    </aside>
  </div>;
}

function MarkdownPreview({ markdown }: { markdown: string }) {
  const parsed = parseMarkdown(markdown);
  const safe = DOMPurify.sanitize(marked.parse(parsed.body, { async: false }) as string);
  return <article className="preview prose" dangerouslySetInnerHTML={{ __html: safe }} />;
}

function GraphView({
  notes,
  graph,
  selectedId,
  onSelect
}: {
  notes: NoteRecord[];
  graph: KnowledgeGraph;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const selectRef = useRef(onSelect);
  const [scope, setScope] = useState<"global" | "local">("global");
  const [depth, setDepth] = useState(1);
  useEffect(() => { selectRef.current = onSelect; }, [onSelect]);

  const visibleGraph = useMemo(() => {
    if (scope === "global" || !selectedId) return graph;
    const nodeIds = localNeighborhood(selectedId, graph, depth);
    return {
      nodes: graph.nodes.filter((node) => nodeIds.has(node.id)),
      edges: graph.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    };
  }, [scope, selectedId, depth, graph]);

  useEffect(() => {
    let disposed = false;
    let destroy: (() => void) | undefined;

    void import("cytoscape").then(({ default: cytoscape }) => {
      if (disposed || !ref.current) return;
      const cy = cytoscape({
        container: ref.current,
        elements: [
          ...visibleGraph.nodes.map((node) => ({ data: { id: node.id, label: node.title, kind: node.kind, selected: node.id === selectedId } })),
          ...visibleGraph.edges.map((edge) => ({ data: { id: edge.id, source: edge.source, target: edge.target, resolved: edge.resolved } }))
        ],
        style: [
          {
            selector: "node",
            style: {
              "background-color": "#7c8cff",
              label: "data(label)",
              color: "#dfe4ef",
              "font-size": 11,
              "text-valign": "bottom",
              "text-margin-y": 8,
              width: 22,
              height: 22
            }
          },
          {
            selector: 'node[selected = "true"]',
            style: { "border-color": "#ffffff", "border-width": 3, width: 27, height: 27 }
          },
          {
            selector: 'node[kind = "unresolved"]',
            style: {
              "background-color": "#343b4b",
              "border-color": "#f4b860",
              "border-width": 2,
              "border-style": "dashed"
            }
          },
          {
            selector: "edge",
            style: {
              width: 1.2,
              "line-color": "#49536a",
              "target-arrow-color": "#49536a",
              "target-arrow-shape": "triangle",
              "curve-style": "bezier"
            }
          }
        ],
        layout: { name: "cose", animate: false, fit: true, padding: 40 }
      });
      cy.on("tap", "node", (event) => selectRef.current(event.target.id()));
      destroy = () => cy.destroy();
    });

    return () => {
      disposed = true;
      destroy?.();
    };
  }, [visibleGraph, selectedId]);

  return <div className="single-view">
    <div className="hero-row graph-header">
      <div>
        <span className="eyebrow">Authored knowledge graph</span>
        <h1>{scope === "global" ? "Connections you can inspect." : "Local neighborhood."}</h1>
        <p>{visibleGraph.nodes.length} visible nodes · {visibleGraph.edges.length} visible edges · {graph.nodes.filter((node) => node.kind === "unresolved").length} unresolved targets overall</p>
      </div>
      <div className="graph-controls">
        <div className="segmented">
          <button className={scope === "global" ? "active" : ""} onClick={() => setScope("global")}>Global</button>
          <button className={scope === "local" ? "active" : ""} onClick={() => setScope("local")} disabled={!selectedId}>Local</button>
        </div>
        {scope === "local" && <label>Depth <select value={depth} onChange={(event) => setDepth(Number(event.target.value))}><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option></select></label>}
      </div>
    </div>
    <div className="legend graph-legend">
      <span><i className="dot resolved"></i>Resolved note</span>
      <span><i className="dot unresolved"></i>Unresolved/ambiguous link</span>
      <span>White ring = current note</span>
    </div>
    <div ref={ref} className="graph-canvas" />
  </div>;
}

function LibraryView({ notes, graph, onOpen }: { notes: NoteRecord[]; graph: KnowledgeGraph; onOpen: (id: string) => void }) {
  const columns = propertyColumns(notes).slice(0, 6);
  return <div className="single-view library-view">
    <span className="eyebrow">Property workspace</span>
    <h1>Structured knowledge, without hiding the Markdown.</h1>
    <p className="lede">This table is derived from YAML frontmatter, tags, and authored links. Markdown remains the source of truth.</p>
    <div className="library-table-wrap">
      <table className="library-table">
        <thead><tr><th>Note</th><th>Tags</th>{columns.map((column) => <th key={column}>{column}</th>)}<th>Links</th><th>Backlinks</th><th>Updated</th></tr></thead>
        <tbody>{notes.map((note) => {
          const parsed = parseMarkdown(note.markdown);
          const backlinks = backlinksFor(note.id, graph, notes).length;
          return <tr key={note.id}>
            <td><button onClick={() => onOpen(note.id)}>{note.title}</button><small>{note.path}</small></td>
            <td>{parsed.tags.length ? parsed.tags.map((tag) => <span className="table-tag" key={tag}>#{tag}</span>) : <span className="muted">—</span>}</td>
            {columns.map((column) => <td key={column}>{formatProperty(parsed.properties[column])}</td>)}
            <td>{parsed.links.length}</td><td>{backlinks}</td><td>{new Date(note.updatedAt).toLocaleDateString()}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  </div>;
}

function formatProperty(value: ReturnType<typeof parseMarkdown>["properties"][string] | undefined) {
  if (value === undefined) return <span className="muted">—</span>;
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function EvidenceView({
  query,
  setQuery,
  run,
  trace,
  onOpen
}: {
  query: string;
  setQuery: (value: string) => void;
  run: () => void;
  trace?: GraphQueryTrace;
  onOpen: (id: string) => void;
}) {
  return <div className="single-view evidence-view">
    <span className="eyebrow">Deterministic graph proof · local</span>
    <h1>Verify retrieval paths before generation.</h1>
    <p className="lede">EvidenceWeave now routes between lexical, local-graph, and multi-hop authored-path retrieval. It still does not claim generative GraphRAG: the result below is the inspectable retrieval proof that a later synthesis layer must be constrained by.</p>
    <div className="ask-box">
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && run()}
        aria-label="Evidence question"
      />
      <button className="primary" onClick={run}>Trace evidence</button>
    </div>

    {trace && <section className="trace-card">
      <div className="trace-head"><span className={`route-badge ${trace.mode}`}>{trace.mode}</span><strong>{trace.anchors.length ? `Anchors: ${trace.anchors.map((anchor) => anchor.title).join(", ")}` : "No graph anchor"}</strong></div>
      <p>{trace.reason}</p>
      {trace.paths.length > 0 && <div className="path-list">{trace.paths.map((path, index) => <div className="path-chip" key={`${path.nodeIds.join("-")}-${index}`}><span>{path.titles.join(" → ")}</span><small>{path.hops} hop{path.hops === 1 ? "" : "s"}</small></div>)}</div>}
    </section>}

    <div className="evidence-list">
      {trace?.evidence.map((hit, index) => <article className="evidence-card" key={hit.noteId}>
        <div className="evidence-head">
          <span>S{index + 1}</span>
          <button onClick={() => onOpen(hit.noteId)}>{hit.title}</button>
          <strong>{Math.round(hit.retrievalScore * 100)}%</strong>
        </div>
        <p>{hit.excerpt}</p>
        <small>Matched: {hit.matchedTerms.join(", ") || "graph anchor"}</small>
        {hit.graphPath && hit.graphPath.hops > 0 && <div className="evidence-path"><b>Authored path</b><span>{hit.graphPath.titles.join(" → ")}</span></div>}
      </article>)}
      {!trace && <div className="empty-evidence">Run a query to inspect the local retrieval plan and graph proof.</div>}
      {trace && !trace.evidence.length && <div className="empty-evidence">Evidence gap: no source note crossed the deterministic support threshold. Existing graph paths alone are not treated as proof of the requested fact.</div>}
    </div>
  </div>;
}

export default App;
