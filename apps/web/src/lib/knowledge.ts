import { parseMarkdown, type KnowledgeGraph, type NoteRecord } from "./core";
import {
  RETRIEVAL_VERSION,
  searchEvidenceBlocks,
  type BlockEvidenceHit
} from "./retrieval";

export interface MentionHit {
  sourceNoteId: string;
  sourceTitle: string;
  excerpt: string;
}

export interface GraphPath {
  nodeIds: string[];
  titles: string[];
  hops: number;
}

export interface GraphEvidenceHit extends BlockEvidenceHit {
  title: string;
  excerpt: string;
  graphPath?: GraphPath;
  retrievalScore: number;
}

export interface GraphQueryTrace {
  question: string;
  createdAt: string;
  retrievalVersion: string;
  mode: "lexical" | "local-graph" | "multi-hop";
  reason: string;
  anchors: { id: string; title: string }[];
  evidence: GraphEvidenceHit[];
  paths: GraphPath[];
}

const normalize = (value: string) => value.trim().toLocaleLowerCase();
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function excerptAt(text: string, start: number, max = 220): string {
  const from = Math.max(0, start - Math.floor(max / 3));
  const excerpt = text.slice(from, from + max).replace(/\s+/g, " ").trim();
  return `${from > 0 ? "…" : ""}${excerpt}${from + max < text.length ? "…" : ""}`;
}

export function unlinkedMentionsFor(target: NoteRecord, notes: NoteRecord[]): MentionHit[] {
  const escapedTitle = escapeRegex(target.title);
  const mentionPattern = new RegExp(`(^|[^\\p{L}\\p{N}_])(${escapedTitle})(?=$|[^\\p{L}\\p{N}_])`, "iu");

  return notes
    .filter((source) => source.id !== target.id)
    .flatMap((source) => {
      const parsed = parseMarkdown(source.markdown);
      const alreadyLinked = parsed.links.some((link) => normalize(link.target) === normalize(target.title));
      if (alreadyLinked) return [];

      const textWithoutLinks = parsed.body.replace(/\[\[[^\]]+\]\]/g, " ");
      const match = mentionPattern.exec(textWithoutLinks);
      if (!match || match.index === undefined) return [];
      return [{
        sourceNoteId: source.id,
        sourceTitle: source.title,
        excerpt: excerptAt(textWithoutLinks, match.index)
      }];
    });
}

export function resolvedSubgraph(graph: KnowledgeGraph, nodeIds: Set<string>): KnowledgeGraph {
  return {
    nodes: graph.nodes.filter((node) => nodeIds.has(node.id)),
    edges: graph.edges.filter((edge) => edge.resolved && nodeIds.has(edge.source) && nodeIds.has(edge.target))
  };
}

export function shortestResolvedPath(
  graph: KnowledgeGraph,
  notes: NoteRecord[],
  sourceId: string,
  targetId: string,
  maxHops = 4
): GraphPath | undefined {
  if (sourceId === targetId) {
    const title = notes.find((note) => note.id === sourceId)?.title ?? sourceId;
    return { nodeIds: [sourceId], titles: [title], hops: 0 };
  }

  const adjacency = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (!edge.resolved) continue;
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set());
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set());
    adjacency.get(edge.source)!.add(edge.target);
    adjacency.get(edge.target)!.add(edge.source);
  }

  const queue: string[][] = [[sourceId]];
  const visited = new Set([sourceId]);

  while (queue.length) {
    const path = queue.shift()!;
    const current = path[path.length - 1];
    const hops = path.length - 1;
    if (hops >= maxHops) continue;

    for (const neighbor of adjacency.get(current) ?? []) {
      if (visited.has(neighbor)) continue;
      const nextPath = [...path, neighbor];
      if (neighbor === targetId) {
        const titleMap = new Map(notes.map((note) => [note.id, note.title]));
        return {
          nodeIds: nextPath,
          titles: nextPath.map((id) => titleMap.get(id) ?? id),
          hops: nextPath.length - 1
        };
      }
      visited.add(neighbor);
      queue.push(nextPath);
    }
  }

  return undefined;
}

function mentionedNotes(question: string, notes: NoteRecord[]): NoteRecord[] {
  const lower = question.toLocaleLowerCase();
  return notes.filter((note) => {
    const title = normalize(note.title);
    return title.length >= 3 && lower.includes(title);
  });
}

export function planGraphEvidence(
  question: string,
  notes: NoteRecord[],
  graph: KnowledgeGraph,
  selectedNoteId?: string,
  limit = 5
): GraphQueryTrace {
  const mentioned = mentionedNotes(question, notes);
  const selected = selectedNoteId ? notes.find((note) => note.id === selectedNoteId) : undefined;
  const anchors = mentioned.length ? mentioned : selected ? [selected] : [];

  const mode: GraphQueryTrace["mode"] = mentioned.length >= 2
    ? "multi-hop"
    : anchors.length
      ? "local-graph"
      : "lexical";

  const reason = mode === "multi-hop"
    ? "Two or more note titles appear in the question, so EvidenceWeave checks authored paths between them."
    : mode === "local-graph"
      ? "The query is grounded around the selected or explicitly named note and nearby authored connections."
      : "No graph anchor was identified, so retrieval remains lexical and evidence-only.";

  const paths: GraphPath[] = [];
  if (mentioned.length >= 2) {
    for (let index = 0; index < mentioned.length - 1; index += 1) {
      for (let next = index + 1; next < mentioned.length; next += 1) {
        const path = shortestResolvedPath(graph, notes, mentioned[index].id, mentioned[next].id);
        if (path) paths.push(path);
      }
    }
  }

  const base = searchEvidenceBlocks(question, notes, Math.max(limit * 4, limit));
  const primaryAnchor = anchors[0];
  const evidence = base.map((hit): GraphEvidenceHit => {
    const graphPath = primaryAnchor
      ? shortestResolvedPath(graph, notes, primaryAnchor.id, hit.noteId, 3)
      : undefined;
    const pathBoost = graphPath && graphPath.hops > 0 ? Math.max(0.03, 0.12 - graphPath.hops * 0.025) : 0;
    return {
      ...hit,
      title: hit.noteTitle,
      excerpt: hit.text,
      graphPath,
      retrievalScore: Math.min(1, hit.score + pathBoost)
    };
  }).sort((left, right) => right.retrievalScore - left.retrievalScore || left.title.localeCompare(right.title) || left.startOffset - right.startOffset).slice(0, limit);

  return {
    question,
    createdAt: new Date().toISOString(),
    retrievalVersion: `${RETRIEVAL_VERSION}+authored-path-v1`,
    mode,
    reason,
    anchors: anchors.map((note) => ({ id: note.id, title: note.title })),
    evidence,
    paths
  };
}

export function propertyColumns(notes: NoteRecord[]): string[] {
  const counts = new Map<string, number>();
  for (const note of notes) {
    for (const key of Object.keys(parseMarkdown(note.markdown).properties)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key]) => key);
}
