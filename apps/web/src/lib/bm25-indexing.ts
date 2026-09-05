import { tokenizeRetrieval } from "./retrieval";
import type { Bm25Index, Bm25Posting, UnifiedSourceBlock } from "./hybrid";

export const BM25_INDEX_VERSION = "bm25-inverted-v2";

export interface Bm25BuildProgress {
  completed: number;
  total: number;
  version: typeof BM25_INDEX_VERSION;
}

export interface Bm25BuildOptions {
  signal?: AbortSignal;
  yieldEvery?: number;
  onProgress?: (progress: Bm25BuildProgress) => void;
}

const abortIfNeeded = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException("BM25 index build cancelled.", "AbortError");
};

const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Builds the deterministic inverted lexical index without monopolizing the UI
 * thread for large workspaces. The resulting index is intentionally in-memory:
 * source blocks remain authoritative and the index can always be rebuilt.
 */
export async function buildBm25IndexCancellable(blocks: UnifiedSourceBlock[], options: Bm25BuildOptions = {}): Promise<Bm25Index> {
  const postings = new Map<string, Bm25Posting[]>();
  const documentFrequency = new Map<string, number>();
  const lengths: number[] = [];
  const yieldEvery = Math.max(1, Math.min(options.yieldEvery ?? 100, 1000));
  options.onProgress?.({ completed: 0, total: blocks.length, version: BM25_INDEX_VERSION });

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    abortIfNeeded(options.signal);
    const block = blocks[blockIndex];
    const tokens = tokenizeRetrieval(`${block.title} ${block.headingPath.join(" ")} ${block.text}`);
    lengths.push(tokens.length);
    const frequencies = new Map<string, number>();
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    for (const [term, termFrequency] of frequencies) {
      const list = postings.get(term) ?? [];
      list.push({ blockIndex, termFrequency });
      postings.set(term, list);
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
    const completed = blockIndex + 1;
    if (completed % yieldEvery === 0 || completed === blocks.length) {
      options.onProgress?.({ completed, total: blocks.length, version: BM25_INDEX_VERSION });
      if (completed < blocks.length) await yieldToBrowser();
    }
  }

  abortIfNeeded(options.signal);
  return {
    blocks,
    lengths,
    averageLength: lengths.reduce((sum, length) => sum + length, 0) / Math.max(1, lengths.length) || 1,
    postings,
    documentFrequency
  };
}
