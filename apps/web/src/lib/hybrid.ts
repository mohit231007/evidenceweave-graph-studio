import { buildWorkspaceBlocks, tokenizeRetrieval } from "./retrieval";
import type { NoteRecord } from "./core";
import type { DocumentBlockRecord, EntityCandidateRecord, RelationCandidateRecord, SourceBounds } from "./store";

export interface UnifiedSourceBlock {
  id: string;
  sourceType: "note" | "document";
  sourceId: string;
  title: string;
  headingPath: string[];
  text: string;
  startOffset?: number;
  endOffset?: number;
  page?: number;
  row?: number;
  section?: string;
  bounds?: SourceBounds[];
  createdAt?: string;
  updatedAt?: string;
  mentionedYears: number[];
}

export interface RankedEvidence {
  block: UnifiedSourceBlock;
  fusedScore: number;
  ranks: Partial<Record<"bm25" | "vector" | "graph", number>>;
  scores: Partial<Record<"bm25" | "vector" | "graph", number>>;
}

export interface EmbeddingProvider {
  id: string;
  version: string;
  workerBacked?: boolean;
  embed(texts: string[], options?: { signal?: AbortSignal }): Promise<number[][]>;
  dispose?(): void;
}

export interface Bm25Posting {
  blockIndex: number;
  termFrequency: number;
}

export interface Bm25Index {
  blocks: UnifiedSourceBlock[];
  lengths: number[];
  averageLength: number;
  postings: Map<string, Bm25Posting[]>;
  documentFrequency: Map<string, number>;
}

export const HYBRID_RETRIEVAL_VERSION = "bm25-inverted+vector-worker+graph-rrf-v2";

const mentionedYears = (text: string) => [...new Set([...text.matchAll(/\b(?:19|20)\d{2}\b/g)].map((match) => Number(match[0])))] .sort((a, b) => a - b);

export function noteBlocks(notes: NoteRecord[]): UnifiedSourceBlock[] {
  return buildWorkspaceBlocks(notes).map((block) => {
    const note = notes.find((item) => item.id === block.noteId);
    return {
      id: block.id,
      sourceType: "note" as const,
      sourceId: block.noteId,
      title: block.noteTitle,
      headingPath: block.headingPath,
      text: block.text,
      startOffset: block.startOffset,
      endOffset: block.endOffset,
      createdAt: note?.createdAt,
      updatedAt: note?.updatedAt,
      mentionedYears: mentionedYears(block.text)
    };
  });
}

export function documentBlocks(blocks: DocumentBlockRecord[]): UnifiedSourceBlock[] {
  return blocks.map((block) => ({
    id: block.id,
    sourceType: "document" as const,
    sourceId: block.documentId,
    title: block.documentTitle,
    headingPath: block.headingPath,
    text: block.text,
    startOffset: block.location.startOffset,
    endOffset: block.location.endOffset,
    page: block.location.page,
    row: block.location.row,
    section: block.location.section,
    bounds: block.location.bounds,
    mentionedYears: mentionedYears(block.text)
  }));
}

function termFrequency(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

export function buildBm25Index(blocks: UnifiedSourceBlock[]): Bm25Index {
  const postings = new Map<string, Bm25Posting[]>();
  const documentFrequency = new Map<string, number>();
  const lengths: number[] = [];
  blocks.forEach((block, blockIndex) => {
    const tokens = tokenizeRetrieval(`${block.title} ${block.headingPath.join(" ")} ${block.text}`);
    lengths.push(tokens.length);
    const frequencies = termFrequency(tokens);
    frequencies.forEach((termFrequencyValue, term) => {
      const list = postings.get(term) ?? [];
      list.push({ blockIndex, termFrequency: termFrequencyValue });
      postings.set(term, list);
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    });
  });
  return {
    blocks,
    lengths,
    averageLength: lengths.reduce((sum, length) => sum + length, 0) / Math.max(1, lengths.length) || 1,
    postings,
    documentFrequency
  };
}

const bm25IndexCache = new WeakMap<UnifiedSourceBlock[], Bm25Index>();

export function bm25IndexFor(blocks: UnifiedSourceBlock[]): Bm25Index {
  const cached = bm25IndexCache.get(blocks);
  if (cached) return cached;
  const index = buildBm25Index(blocks);
  bm25IndexCache.set(blocks, index);
  return index;
}

export function bm25RankFromIndex(query: string, index: Bm25Index, limit = 20, k1 = 1.5, b = 0.75): { block: UnifiedSourceBlock; score: number }[] {
  const terms = [...new Set(tokenizeRetrieval(query))];
  if (!terms.length || !index.blocks.length) return [];
  const scores = new Map<number, number>();
  for (const term of terms) {
    const postings = index.postings.get(term) ?? [];
    const df = index.documentFrequency.get(term) ?? 0;
    if (!df) continue;
    const idf = Math.log(1 + (index.blocks.length - df + 0.5) / (df + 0.5));
    for (const posting of postings) {
      const length = index.lengths[posting.blockIndex] || 1;
      const denominator = posting.termFrequency + k1 * (1 - b + b * length / index.averageLength);
      const score = idf * (posting.termFrequency * (k1 + 1)) / denominator;
      scores.set(posting.blockIndex, (scores.get(posting.blockIndex) ?? 0) + score);
    }
  }
  const raw = [...scores.entries()].map(([blockIndex, score]) => ({ block: index.blocks[blockIndex], score }))
    .filter((hit) => hit.score > 0)
    .sort((left, right) => right.score - left.score || left.block.id.localeCompare(right.block.id));
  const max = raw[0]?.score ?? 1;
  return raw.slice(0, limit).map((hit) => ({ ...hit, score: hit.score / max }));
}

export function bm25Rank(query: string, blocks: UnifiedSourceBlock[], limit = 20, k1 = 1.5, b = 0.75): { block: UnifiedSourceBlock; score: number }[] {
  return bm25RankFromIndex(query, bm25IndexFor(blocks), limit, k1, b);
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0;
  let normLeft = 0;
  let normRight = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    normLeft += left[index] ** 2;
    normRight += right[index] ** 2;
  }
  if (!normLeft || !normRight) return 0;
  return dot / Math.sqrt(normLeft * normRight);
}

export async function vectorRank(query: string, blocks: UnifiedSourceBlock[], provider: EmbeddingProvider, limit = 20, signal?: AbortSignal): Promise<{ block: UnifiedSourceBlock; score: number }[]> {
  if (!query.trim() || !blocks.length) return [];
  const [queryVector, ...vectors] = await provider.embed([query, ...blocks.map((block) => `${block.title}\n${block.headingPath.join(" > ")}\n${block.text}`)], { signal });
  return blocks.map((block, index) => ({ block, score: cosineSimilarity(queryVector, vectors[index]) }))
    .filter((hit) => Number.isFinite(hit.score) && hit.score > 0)
    .sort((left, right) => right.score - left.score || left.block.id.localeCompare(right.block.id))
    .slice(0, limit);
}

function acceptedGraph(entities: EntityCandidateRecord[], relations: RelationCandidateRecord[]) {
  const acceptedEntities = entities.filter((entity) => entity.status === "accepted" && !entity.mergedIntoId);
  const acceptedIds = new Set(acceptedEntities.map((entity) => entity.id));
  const acceptedRelations = relations.filter((relation) => relation.status === "accepted" && acceptedIds.has(relation.sourceEntityId) && acceptedIds.has(relation.targetEntityId));
  return { acceptedEntities, acceptedRelations };
}

export function graphCommunities(entities: EntityCandidateRecord[], relations: RelationCandidateRecord[]): string[][] {
  const { acceptedEntities, acceptedRelations } = acceptedGraph(entities, relations);
  const adjacency = new Map(acceptedEntities.map((entity) => [entity.id, new Set<string>()]));
  for (const relation of acceptedRelations) {
    adjacency.get(relation.sourceEntityId)?.add(relation.targetEntityId);
    adjacency.get(relation.targetEntityId)?.add(relation.sourceEntityId);
  }
  const visited = new Set<string>();
  const communities: string[][] = [];
  for (const entity of acceptedEntities) {
    if (visited.has(entity.id)) continue;
    const queue = [entity.id];
    visited.add(entity.id);
    const component: string[] = [];
    while (queue.length) {
      const current = queue.shift()!;
      component.push(current);
      for (const neighbor of adjacency.get(current) ?? []) if (!visited.has(neighbor)) { visited.add(neighbor); queue.push(neighbor); }
    }
    communities.push(component.sort());
  }
  return communities.sort((left, right) => right.length - left.length || left[0]?.localeCompare(right[0] ?? "") || 0);
}

export function communityGraphRank(
  query: string,
  blocks: UnifiedSourceBlock[],
  entities: EntityCandidateRecord[],
  relations: RelationCandidateRecord[],
  limit = 20
): { block: UnifiedSourceBlock; score: number }[] {
  const { acceptedEntities, acceptedRelations } = acceptedGraph(entities, relations);
  if (!acceptedEntities.length) return [];
  const entityById = new Map(acceptedEntities.map((entity) => [entity.id, entity]));
  const queryTerms = new Set(tokenizeRetrieval(query));
  const communities = graphCommunities(entities, relations);
  const evidence = new Map<string, number>();
  communities.forEach((community, communityIndex) => {
    const names = community.flatMap((id) => tokenizeRetrieval(entityById.get(id)?.canonicalName ?? ""));
    const labels = acceptedRelations.filter((relation) => community.includes(relation.sourceEntityId) && community.includes(relation.targetEntityId)).flatMap((relation) => tokenizeRetrieval(relation.relation));
    const lexicalMatches = [...new Set([...names, ...labels])].filter((term) => queryTerms.has(term)).length;
    const breadth = Math.min(1, Math.log2(community.length + 1) / 5);
    const score = lexicalMatches ? Math.min(1, 0.55 + lexicalMatches * 0.12 + breadth * 0.2) : Math.max(0.15, breadth * (1 - communityIndex * 0.08));
    for (const id of community) for (const blockId of entityById.get(id)?.evidenceBlockIds ?? []) evidence.set(blockId, Math.max(evidence.get(blockId) ?? 0, score));
    for (const relation of acceptedRelations.filter((item) => community.includes(item.sourceEntityId) && community.includes(item.targetEntityId))) for (const blockId of relation.evidenceBlockIds) evidence.set(blockId, Math.max(evidence.get(blockId) ?? 0, Math.min(1, score + 0.08)));
  });
  return blocks.filter((block) => evidence.has(block.id)).map((block) => ({ block, score: evidence.get(block.id)! }))
    .sort((left, right) => right.score - left.score || left.block.id.localeCompare(right.block.id)).slice(0, limit);
}

export function graphRank(
  query: string,
  blocks: UnifiedSourceBlock[],
  entities: EntityCandidateRecord[],
  relations: RelationCandidateRecord[],
  limit = 20
): { block: UnifiedSourceBlock; score: number }[] {
  const lower = query.toLocaleLowerCase();
  const { acceptedEntities, acceptedRelations } = acceptedGraph(entities, relations);
  const anchors = acceptedEntities.filter((entity) => entity.canonicalName.length >= 3 && lower.includes(entity.canonicalName.toLocaleLowerCase()));
  if (!anchors.length) return communityGraphRank(query, blocks, entities, relations, limit);
  const entityIds = new Set(anchors.map((entity) => entity.id));
  for (let hop = 0; hop < 2; hop += 1) {
    for (const relation of acceptedRelations) {
      if (entityIds.has(relation.sourceEntityId) || entityIds.has(relation.targetEntityId)) {
        entityIds.add(relation.sourceEntityId);
        entityIds.add(relation.targetEntityId);
      }
    }
  }
  const evidence = new Map<string, number>();
  for (const entity of acceptedEntities) if (entityIds.has(entity.id)) for (const blockId of entity.evidenceBlockIds) evidence.set(blockId, Math.max(evidence.get(blockId) ?? 0, anchors.some((anchor) => anchor.id === entity.id) ? 1 : 0.7));
  for (const relation of acceptedRelations) if (entityIds.has(relation.sourceEntityId) && entityIds.has(relation.targetEntityId)) for (const blockId of relation.evidenceBlockIds) evidence.set(blockId, Math.max(evidence.get(blockId) ?? 0, 0.82));
  return blocks.filter((block) => evidence.has(block.id)).map((block) => ({ block, score: evidence.get(block.id)! }))
    .sort((left, right) => right.score - left.score || left.block.id.localeCompare(right.block.id)).slice(0, limit);
}

export function reciprocalRankFusion(
  channels: Partial<Record<"bm25" | "vector" | "graph", { block: UnifiedSourceBlock; score: number }[]>>,
  limit = 10,
  k = 60
): RankedEvidence[] {
  const fused = new Map<string, RankedEvidence>();
  for (const channel of ["bm25", "vector", "graph"] as const) {
    const results = channels[channel] ?? [];
    results.forEach((result, index) => {
      const existing = fused.get(result.block.id) ?? { block: result.block, fusedScore: 0, ranks: {}, scores: {} };
      existing.ranks[channel] = index + 1;
      existing.scores[channel] = result.score;
      existing.fusedScore += 1 / (k + index + 1);
      fused.set(result.block.id, existing);
    });
  }
  return [...fused.values()].sort((left, right) => right.fusedScore - left.fusedScore || left.block.id.localeCompare(right.block.id)).slice(0, limit);
}

export async function hybridRetrieve(
  query: string,
  blocks: UnifiedSourceBlock[],
  entities: EntityCandidateRecord[] = [],
  relations: RelationCandidateRecord[] = [],
  provider?: EmbeddingProvider,
  limit = 10,
  signal?: AbortSignal
): Promise<RankedEvidence[]> {
  const bm25 = bm25Rank(query, blocks, Math.max(limit * 3, 20));
  const graph = graphRank(query, blocks, entities, relations, Math.max(limit * 3, 20));
  const vector = provider ? await vectorRank(query, blocks, provider, Math.max(limit * 3, 20), signal) : [];
  return reciprocalRankFusion({ bm25, vector, graph }, limit);
}

async function createDirectTransformersProvider(modelId: string): Promise<EmbeddingProvider> {
  const { pipeline } = await import("@huggingface/transformers");
  const supportsWebGpu = typeof navigator !== "undefined" && "gpu" in navigator;
  const extractor = await pipeline("feature-extraction", modelId, { device: supportsWebGpu ? "webgpu" : "wasm", dtype: "q8" });
  return {
    id: modelId,
    version: "transformers.js-4.2.0",
    workerBacked: false,
    async embed(texts: string[], options = {}) {
      const vectors: number[][] = [];
      for (const text of texts) {
        if (options.signal?.aborted) throw new DOMException("Embedding cancelled.", "AbortError");
        const output = await extractor(text, { pooling: "mean", normalize: true }) as unknown as { tolist(): unknown };
        const raw = output.tolist();
        const first = Array.isArray(raw) && Array.isArray(raw[0]) ? raw[0] : raw;
        vectors.push((first as number[]).map(Number));
      }
      return vectors;
    }
  };
}

interface EmbeddingWorkerMessage {
  type: "ready" | "result" | "error";
  requestId?: string;
  vectors?: number[][];
  error?: string;
  device?: string;
}

async function createWorkerTransformersProvider(modelId: string): Promise<EmbeddingProvider> {
  const worker = new Worker(new URL("./embedding.worker.ts", import.meta.url), { type: "module", name: "evidenceweave-embedding-worker" });
  const pending = new Map<string, { resolve: (vectors: number[][]) => void; reject: (error: Error) => void }>();
  let disposed = false;
  const ready = new Promise<void>((resolve, reject) => {
    const fail = (message: string) => { worker.terminate(); reject(new Error(message)); };
    worker.onerror = (event) => fail(event.message || "Embedding worker failed to initialize.");
    worker.onmessage = (event: MessageEvent<EmbeddingWorkerMessage>) => {
      const message = event.data;
      if (message.type === "ready") { resolve(); return; }
      if (message.type === "error" && !message.requestId) { fail(message.error ?? "Embedding worker failed to initialize."); return; }
      if (!message.requestId) return;
      const request = pending.get(message.requestId);
      if (!request) return;
      pending.delete(message.requestId);
      if (message.type === "result" && message.vectors) request.resolve(message.vectors);
      else request.reject(new Error(message.error ?? "Embedding worker failed."));
    };
  });
  worker.postMessage({ type: "init", modelId });
  await ready;
  return {
    id: modelId,
    version: "transformers.js-4.2.0-worker-v1",
    workerBacked: true,
    embed(texts: string[], options = {}) {
      if (disposed) return Promise.reject(new Error("Embedding worker has been disposed."));
      const requestId = crypto.randomUUID();
      return new Promise<number[][]>((resolve, reject) => {
        const abort = () => {
          pending.delete(requestId);
          worker.postMessage({ type: "cancel", requestId });
          reject(new DOMException("Embedding cancelled.", "AbortError"));
        };
        if (options.signal?.aborted) { abort(); return; }
        options.signal?.addEventListener("abort", abort, { once: true });
        pending.set(requestId, {
          resolve: (vectors) => { options.signal?.removeEventListener("abort", abort); resolve(vectors); },
          reject: (error) => { options.signal?.removeEventListener("abort", abort); reject(error); }
        });
        worker.postMessage({ type: "embed", requestId, texts });
      });
    },
    dispose() {
      disposed = true;
      worker.terminate();
      for (const request of pending.values()) request.reject(new Error("Embedding worker disposed."));
      pending.clear();
    }
  };
}

export async function createTransformersProvider(modelId = "Xenova/all-MiniLM-L6-v2"): Promise<EmbeddingProvider> {
  if (typeof Worker !== "undefined") {
    try { return await createWorkerTransformersProvider(modelId); }
    catch { /* fall through to direct WASM/WebGPU provider */ }
  }
  return createDirectTransformersProvider(modelId);
}
