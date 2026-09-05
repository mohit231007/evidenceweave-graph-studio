import { buildWorkspaceBlocks, tokenizeRetrieval } from "./retrieval";
import type { NoteRecord } from "./core";
import type { DocumentBlockRecord, EntityCandidateRecord, RelationCandidateRecord } from "./store";

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
  embed(texts: string[]): Promise<number[][]>;
}

export const HYBRID_RETRIEVAL_VERSION = "bm25+vector+graph-rrf-v1";

export function noteBlocks(notes: NoteRecord[]): UnifiedSourceBlock[] {
  return buildWorkspaceBlocks(notes).map((block) => ({
    id: block.id,
    sourceType: "note",
    sourceId: block.noteId,
    title: block.noteTitle,
    headingPath: block.headingPath,
    text: block.text,
    startOffset: block.startOffset,
    endOffset: block.endOffset
  }));
}

export function documentBlocks(blocks: DocumentBlockRecord[]): UnifiedSourceBlock[] {
  return blocks.map((block) => ({
    id: block.id,
    sourceType: "document",
    sourceId: block.documentId,
    title: block.documentTitle,
    headingPath: block.headingPath,
    text: block.text,
    startOffset: block.location.startOffset,
    endOffset: block.location.endOffset,
    page: block.location.page,
    row: block.location.row,
    section: block.location.section
  }));
}

function termFrequency(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

export function bm25Rank(query: string, blocks: UnifiedSourceBlock[], limit = 20, k1 = 1.5, b = 0.75): { block: UnifiedSourceBlock; score: number }[] {
  const terms = tokenizeRetrieval(query);
  if (!terms.length || !blocks.length) return [];
  const tokenized = blocks.map((block) => tokenizeRetrieval(`${block.title} ${block.headingPath.join(" ")} ${block.text}`));
  const frequencies = tokenized.map(termFrequency);
  const averageLength = tokenized.reduce((sum, tokens) => sum + tokens.length, 0) / tokenized.length || 1;
  const documentFrequency = new Map<string, number>();
  for (const term of terms) documentFrequency.set(term, tokenized.reduce((count, tokens) => count + (tokens.includes(term) ? 1 : 0), 0));
  const raw = blocks.map((block, index) => {
    let score = 0;
    for (const term of terms) {
      const tf = frequencies[index].get(term) ?? 0;
      if (!tf) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (blocks.length - df + 0.5) / (df + 0.5));
      const denominator = tf + k1 * (1 - b + b * tokenized[index].length / averageLength);
      score += idf * (tf * (k1 + 1)) / denominator;
    }
    return { block, score };
  }).filter((hit) => hit.score > 0).sort((left, right) => right.score - left.score || left.block.id.localeCompare(right.block.id));
  const max = raw[0]?.score ?? 1;
  return raw.slice(0, limit).map((hit) => ({ ...hit, score: hit.score / max }));
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

export async function vectorRank(query: string, blocks: UnifiedSourceBlock[], provider: EmbeddingProvider, limit = 20): Promise<{ block: UnifiedSourceBlock; score: number }[]> {
  if (!query.trim() || !blocks.length) return [];
  const [queryVector, ...vectors] = await provider.embed([query, ...blocks.map((block) => `${block.title}\n${block.headingPath.join(" > ")}\n${block.text}`)]);
  return blocks.map((block, index) => ({ block, score: cosineSimilarity(queryVector, vectors[index]) }))
    .filter((hit) => Number.isFinite(hit.score) && hit.score > 0)
    .sort((left, right) => right.score - left.score || left.block.id.localeCompare(right.block.id))
    .slice(0, limit);
}

export function graphRank(
  query: string,
  blocks: UnifiedSourceBlock[],
  entities: EntityCandidateRecord[],
  relations: RelationCandidateRecord[],
  limit = 20
): { block: UnifiedSourceBlock; score: number }[] {
  const lower = query.toLocaleLowerCase();
  const acceptedEntities = entities.filter((entity) => entity.status === "accepted");
  const anchors = acceptedEntities.filter((entity) => entity.canonicalName.length >= 3 && lower.includes(entity.canonicalName.toLocaleLowerCase()));
  if (!anchors.length) return [];
  const acceptedRelations = relations.filter((relation) => relation.status === "accepted");
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
  limit = 10
): Promise<RankedEvidence[]> {
  const bm25 = bm25Rank(query, blocks, Math.max(limit * 3, 20));
  const graph = graphRank(query, blocks, entities, relations, Math.max(limit * 3, 20));
  const vector = provider ? await vectorRank(query, blocks, provider, Math.max(limit * 3, 20)) : [];
  return reciprocalRankFusion({ bm25, vector, graph }, limit);
}

export async function createTransformersProvider(modelId = "Xenova/all-MiniLM-L6-v2"): Promise<EmbeddingProvider> {
  const { pipeline } = await import("@huggingface/transformers");
  const supportsWebGpu = typeof navigator !== "undefined" && "gpu" in navigator;
  const extractor = await pipeline("feature-extraction", modelId, { device: supportsWebGpu ? "webgpu" : "wasm", dtype: "q8" });
  return {
    id: modelId,
    version: "transformers.js-4.2.0",
    async embed(texts: string[]) {
      const vectors: number[][] = [];
      for (const text of texts) {
        const output = await extractor(text, { pooling: "mean", normalize: true }) as unknown as { tolist(): unknown };
        const raw = output.tolist();
        const first = Array.isArray(raw) && Array.isArray(raw[0]) ? raw[0] : raw;
        vectors.push((first as number[]).map(Number));
      }
      return vectors;
    }
  };
}
