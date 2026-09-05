import { parseMarkdown, type NoteRecord } from "./core";

export interface SourceBlock {
  id: string;
  noteId: string;
  noteTitle: string;
  headingPath: string[];
  text: string;
  startOffset: number;
  endOffset: number;
}

export interface BlockEvidenceHit extends SourceBlock {
  score: number;
  matchedTerms: string[];
  weightedCoverage: number;
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "what", "which", "who", "how", "are", "was", "were",
  "into", "your", "about", "have", "has", "does", "say", "says", "where", "when", "why", "can", "could", "would"
]);

export const DEFAULT_BLOCK_MAX_CHARS = 900;
export const DEFAULT_BLOCK_OVERLAP = 90;
export const RETRIEVAL_VERSION = "weighted-lexical-block-v1";

export function tokenizeRetrieval(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{1,}/gu) ?? [])]
    .filter((token) => !STOP_WORDS.has(token));
}

function updateHeadingPath(current: string[], level: number, title: string): string[] {
  const next = current.slice(0, Math.max(0, level - 1));
  next[level - 1] = title.trim();
  return next.filter(Boolean);
}

function splitLongRange(
  note: NoteRecord,
  headingPath: string[],
  start: number,
  end: number,
  maxChars: number,
  overlap: number
): SourceBlock[] {
  const blocks: SourceBlock[] = [];
  let cursor = start;
  while (cursor < end) {
    let blockEnd = Math.min(end, cursor + maxChars);
    if (blockEnd < end) {
      const slice = note.markdown.slice(cursor, blockEnd);
      const sentence = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("\n"), slice.lastIndexOf("; "));
      if (sentence >= Math.floor(maxChars * 0.55)) blockEnd = cursor + sentence + 1;
    }
    const text = note.markdown.slice(cursor, blockEnd).trim();
    if (text) {
      const actualStart = note.markdown.indexOf(text, cursor);
      const actualEnd = actualStart + text.length;
      blocks.push({
        id: `${note.id}::${actualStart}-${actualEnd}`,
        noteId: note.id,
        noteTitle: note.title,
        headingPath: [...headingPath],
        text,
        startOffset: actualStart,
        endOffset: actualEnd
      });
    }
    if (blockEnd >= end) break;
    cursor = Math.max(cursor + 1, blockEnd - overlap);
  }
  return blocks;
}

export function buildNoteBlocks(
  note: NoteRecord,
  maxChars = DEFAULT_BLOCK_MAX_CHARS,
  overlap = DEFAULT_BLOCK_OVERLAP
): SourceBlock[] {
  if (maxChars < 120) throw new Error("Block size must be at least 120 characters.");
  if (overlap < 0 || overlap >= maxChars) throw new Error("Block overlap must be non-negative and smaller than block size.");

  const parsed = parseMarkdown(note.markdown);
  const body = parsed.body;
  if (!body.trim()) return [];
  const bodyStart = note.markdown.indexOf(body);
  const paragraphRegex = /\S[\s\S]*?(?=\n\s*\n|$)/g;
  const paragraphs = [...body.matchAll(paragraphRegex)];
  const blocks: SourceBlock[] = [];
  let headingPath: string[] = [];
  let pending: { start: number; end: number; headingPath: string[] } | undefined;

  const flush = () => {
    if (!pending) return;
    const length = pending.end - pending.start;
    blocks.push(...splitLongRange(note, pending.headingPath, pending.start, pending.end, maxChars, overlap));
    pending = undefined;
    return length;
  };

  for (const match of paragraphs) {
    if (match.index === undefined) continue;
    const raw = match[0];
    const relativeStart = match.index;
    const absoluteStart = bodyStart + relativeStart;
    const absoluteEnd = absoluteStart + raw.length;
    const firstLine = raw.split(/\r?\n/, 1)[0].trim();
    const heading = firstLine.match(/^(#{1,6})\s+(.+)$/);

    if (heading) {
      flush();
      headingPath = updateHeadingPath(headingPath, heading[1].length, heading[2]);
      const remaining = raw.slice(raw.indexOf(firstLine) + firstLine.length).trim();
      if (!remaining) continue;
      const remainingStart = note.markdown.indexOf(remaining, absoluteStart + firstLine.length);
      pending = { start: remainingStart, end: remainingStart + remaining.length, headingPath: [...headingPath] };
      continue;
    }

    if (!pending) {
      pending = { start: absoluteStart, end: absoluteEnd, headingPath: [...headingPath] };
      continue;
    }

    const sameHeading = pending.headingPath.join("\u0000") === headingPath.join("\u0000");
    const combinedLength = absoluteEnd - pending.start;
    if (sameHeading && combinedLength <= maxChars) {
      pending.end = absoluteEnd;
    } else {
      flush();
      pending = { start: absoluteStart, end: absoluteEnd, headingPath: [...headingPath] };
    }
  }
  flush();

  if (!blocks.length && body.trim()) {
    const text = body.trim();
    const start = note.markdown.indexOf(text, Math.max(0, bodyStart));
    return splitLongRange(note, headingPath, start, start + text.length, maxChars, overlap);
  }
  return blocks;
}

export function buildWorkspaceBlocks(notes: NoteRecord[]): SourceBlock[] {
  return notes.flatMap((note) => buildNoteBlocks(note));
}

function termIdf(term: string, blocks: SourceBlock[]): number {
  const containing = blocks.reduce((count, block) => count + (block.text.toLocaleLowerCase().includes(term) || block.noteTitle.toLocaleLowerCase().includes(term) ? 1 : 0), 0);
  return Math.log((blocks.length + 1) / (containing + 1)) + 1;
}

export function searchEvidenceBlocks(question: string, notes: NoteRecord[], limit = 8): BlockEvidenceHit[] {
  const terms = tokenizeRetrieval(question);
  if (!terms.length) return [];
  const blocks = buildWorkspaceBlocks(notes);
  if (!blocks.length) return [];

  const idf = new Map(terms.map((term) => [term, termIdf(term, blocks)]));
  const totalWeight = terms.reduce((sum, term) => sum + (idf.get(term) ?? 1), 0) || 1;

  return blocks.map((block) => {
    const text = block.text.toLocaleLowerCase();
    const title = block.noteTitle.toLocaleLowerCase();
    const heading = block.headingPath.join(" ").toLocaleLowerCase();
    const matchedTerms = terms.filter((term) => text.includes(term) || title.includes(term) || heading.includes(term));
    const matchedWeight = matchedTerms.reduce((sum, term) => sum + (idf.get(term) ?? 1), 0);
    const weightedCoverage = matchedWeight / totalWeight;
    const titleMatches = matchedTerms.filter((term) => title.includes(term)).length;
    const headingMatches = matchedTerms.filter((term) => heading.includes(term)).length;
    const rarestMatched = matchedTerms.reduce((max, term) => Math.max(max, idf.get(term) ?? 0), 0);
    const score = Math.min(1, weightedCoverage * 0.78 + Math.min(titleMatches * 0.12, 0.18) + Math.min(headingMatches * 0.06, 0.1));
    const supported = titleMatches > 0 || headingMatches > 0 || weightedCoverage >= 0.24 || (matchedTerms.length === 1 && rarestMatched >= 1.45 && matchedTerms[0].length >= 5);
    return { ...block, score, matchedTerms, weightedCoverage, supported };
  })
    .filter((hit) => hit.supported)
    .sort((left, right) => right.score - left.score || left.noteTitle.localeCompare(right.noteTitle) || left.startOffset - right.startOffset)
    .slice(0, limit)
    .map(({ supported: _supported, ...hit }) => hit);
}
