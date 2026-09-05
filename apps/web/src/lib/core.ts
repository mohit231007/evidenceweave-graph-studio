import Dexie, { type Table } from "dexie";

export interface NoteRecord {
  id: string;
  path: string;
  title: string;
  markdown: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceExportV0 {
  schemaVersion: 0;
  exportedAt: string;
  workspace: WorkspaceMeta;
  notes: NoteRecord[];
}

export type PropertyValue = string | number | boolean | string[];

export interface ParsedMarkdown {
  body: string;
  properties: Record<string, PropertyValue>;
  links: { raw: string; target: string; heading?: string; alias?: string }[];
  tags: string[];
}

export interface GraphNode {
  id: string;
  title: string;
  kind: "note" | "unresolved";
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: "links-to";
  resolved: boolean;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface EvidenceHit {
  noteId: string;
  title: string;
  score: number;
  excerpt: string;
  matchedTerms: string[];
}

const now = () => new Date().toISOString();
const normalize = (value: string) => value.trim().toLocaleLowerCase();
const STOP_WORDS = new Set(["the", "and", "for", "with", "that", "this", "from", "what", "which", "who", "how", "are", "was", "were", "into", "your", "about", "have", "has"]);
const tokenize = (value: string) => [...new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{1,}/gu) ?? [])].filter((token) => !STOP_WORDS.has(token));

function parseScalar(raw: string): PropertyValue {
  const value = raw.trim();
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) return value.slice(1, -1).split(",").map((item) => item.trim().replace(/^['\"]|['\"]$/g, "")).filter(Boolean);
  return value.replace(/^['\"]|['\"]$/g, "");
}

export function parseMarkdown(markdown: string): ParsedMarkdown {
  let body = markdown;
  const properties: Record<string, PropertyValue> = {};
  const fm = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
      if (match) properties[match[1]] = parseScalar(match[2]);
    }
    body = markdown.slice(fm[0].length);
  }
  const links = [...body.matchAll(/\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g)].map((match) => ({ raw: match[0], target: match[1].trim(), heading: match[2]?.trim(), alias: match[3]?.trim() }));
  const tags = [...new Set([...body.matchAll(/(^|\s)#([\p{L}\p{N}_/-]+)/gu)].map((match) => match[2]))];
  return { body, properties, links, tags };
}

export function buildAuthoredGraph(notes: NoteRecord[]): KnowledgeGraph {
  const titleIndex = new Map(notes.map((note) => [normalize(note.title), note]));
  const nodes: GraphNode[] = notes.map((note) => ({ id: note.id, title: note.title, kind: "note" }));
  const unresolved = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  for (const note of notes) {
    for (const link of parseMarkdown(note.markdown).links) {
      const resolved = titleIndex.get(normalize(link.target));
      const targetId = resolved?.id ?? `unresolved:${normalize(link.target)}`;
      if (!resolved && !unresolved.has(targetId)) unresolved.set(targetId, { id: targetId, title: link.target, kind: "unresolved" });
      edges.push({ id: `${note.id}->${targetId}:${edges.length}`, source: note.id, target: targetId, label: "links-to", resolved: Boolean(resolved) });
    }
  }
  return { nodes: [...nodes, ...unresolved.values()], edges };
}

export function backlinksFor(noteId: string, graph: KnowledgeGraph, notes: NoteRecord[]): NoteRecord[] {
  const ids = new Set(graph.edges.filter((edge) => edge.target === noteId).map((edge) => edge.source));
  return notes.filter((note) => ids.has(note.id));
}

export function localNeighborhood(noteId: string, graph: KnowledgeGraph, depth = 1): Set<string> {
  const seen = new Set([noteId]);
  let frontier = new Set([noteId]);
  for (let step = 0; step < Math.max(0, depth); step += 1) {
    const next = new Set<string>();
    for (const edge of graph.edges) {
      if (frontier.has(edge.source) && !seen.has(edge.target)) next.add(edge.target);
      if (frontier.has(edge.target) && !seen.has(edge.source)) next.add(edge.source);
    }
    next.forEach((id) => seen.add(id));
    frontier = next;
  }
  return seen;
}

function excerptAround(text: string, terms: string[], max = 280): string {
  const plain = text.replace(/^---[\s\S]*?---\s*/m, "").replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, "$2$1");
  const lower = plain.toLocaleLowerCase();
  const positions = terms.map((term) => lower.indexOf(term)).filter((p) => p >= 0);
  const pivot = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, pivot - Math.floor(max / 3));
  const excerpt = plain.slice(start, start + max).trim().replace(/\s+/g, " ");
  return `${start > 0 ? "…" : ""}${excerpt}${start + max < plain.length ? "…" : ""}`;
}

export function extractiveEvidenceSearch(question: string, notes: NoteRecord[], graph: KnowledgeGraph, limit = 5): EvidenceHit[] {
  const terms = tokenize(question);
  if (!terms.length) return [];
  const linkedDegree = new Map<string, number>();
  for (const edge of graph.edges) {
    linkedDegree.set(edge.source, (linkedDegree.get(edge.source) ?? 0) + 1);
    linkedDegree.set(edge.target, (linkedDegree.get(edge.target) ?? 0) + 1);
  }
  return notes.map((note) => {
    const haystack = `${note.title}\n${note.markdown}`.toLocaleLowerCase();
    const matched = terms.filter((term) => haystack.includes(term));
    const titleMatches = terms.filter((term) => note.title.toLocaleLowerCase().includes(term)).length;
    const coverage = matched.length / terms.length;
    const graphBonus = Math.min((linkedDegree.get(note.id) ?? 0) * 0.02, 0.1);
    const score = coverage + titleMatches * 0.15 + graphBonus;
    return { noteId: note.id, title: note.title, score, excerpt: excerptAround(note.markdown, matched), matchedTerms: matched };
  }).filter((hit) => hit.matchedTerms.length > 0).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
}

class EvidenceWeaveDB extends Dexie {
  notes!: Table<NoteRecord, string>;
  constructor() {
    super("evidenceweave");
    this.version(1).stores({ notes: "id, title, path, updatedAt" });
  }
}

export const db = new EvidenceWeaveDB();
export const DEFAULT_WORKSPACE: WorkspaceMeta = { id: "local-default", title: "My EvidenceWeave", createdAt: now(), updatedAt: now() };

export async function seedIfEmpty(): Promise<void> {
  if (await db.notes.count()) return;
  const createdAt = now();
  await db.notes.bulkAdd([
    { id: crypto.randomUUID(), path: "Welcome.md", title: "Welcome", createdAt, updatedAt: createdAt, markdown: `---\ntype: guide\nstatus: active\ntags: [evidenceweave, local-first]\n---\n# Welcome to EvidenceWeave\n\nEvidenceWeave is a local-first workspace. Start by creating notes and connecting them with wiki links such as [[Evidence]] and [[GraphRAG]].\n\n#start-here #local-first` },
    { id: crypto.randomUUID(), path: "Evidence.md", title: "Evidence", createdAt, updatedAt: createdAt, markdown: `# Evidence\n\nA useful knowledge graph should preserve where a statement came from. In EvidenceWeave, authored links are deterministic and future inferred edges must carry source provenance.\n\nRelated: [[GraphRAG]] and [[Welcome]].\n\n#provenance #verification` },
    { id: crypto.randomUUID(), path: "GraphRAG.md", title: "GraphRAG", createdAt, updatedAt: createdAt, markdown: `# GraphRAG\n\nGraphRAG combines retrieval with explicit relationships. The first release builds the authored graph before adding inferred entities, semantic edges, community retrieval, or local generation.\n\nFoundation: [[Evidence]].\n\n#graphrag #roadmap` }
  ]);
}

export async function exportWorkspace(notes: NoteRecord[]): Promise<WorkspaceExportV0> {
  return { schemaVersion: 0, exportedAt: now(), workspace: { ...DEFAULT_WORKSPACE, updatedAt: now() }, notes };
}

export function validateWorkspaceExport(value: unknown): WorkspaceExportV0 {
  if (!value || typeof value !== "object") throw new Error("Workspace export must be an object.");
  const candidate = value as Partial<WorkspaceExportV0>;
  if (candidate.schemaVersion !== 0 || !Array.isArray(candidate.notes) || !candidate.workspace) throw new Error("Unsupported or malformed EvidenceWeave workspace export.");
  for (const note of candidate.notes) if (!note || typeof note.id !== "string" || typeof note.title !== "string" || typeof note.markdown !== "string") throw new Error("Workspace contains a malformed note.");
  return candidate as WorkspaceExportV0;
}

export async function importWorkspace(payload: WorkspaceExportV0): Promise<void> {
  await db.transaction("rw", db.notes, async () => { await db.notes.clear(); await db.notes.bulkPut(payload.notes); });
}
