import { sha256Hex } from "./documents";
import { bm25Rank, cosineSimilarity, graphRank, reciprocalRankFusion, type EmbeddingProvider, type RankedEvidence, type UnifiedSourceBlock } from "./hybrid";
import { knowledgeDb, type EmbeddingRecord, type EntityCandidateRecord, type RelationCandidateRecord } from "./store";

export interface SemanticIndexProgress {
  completed: number;
  total: number;
  reused: number;
  created: number;
}

export interface SemanticIndexOptions {
  batchSize?: number;
  signal?: AbortSignal;
  onProgress?: (progress: SemanticIndexProgress) => void;
}

export function semanticInput(block: UnifiedSourceBlock): string {
  return `${block.title}\n${block.headingPath.join(" > ")}\n${block.text}`;
}

export async function semanticContentHash(block: UnifiedSourceBlock): Promise<string> {
  return sha256Hex(semanticInput(block));
}

export function embeddingRecordId(provider: Pick<EmbeddingProvider, "id">, blockId: string): string {
  return `${provider.id}::${blockId}`;
}

export function isEmbeddingFresh(record: EmbeddingRecord | undefined, provider: EmbeddingProvider, contentHash: string): boolean {
  return Boolean(record && record.modelId === provider.id && record.modelVersion === provider.version && record.contentHash === contentHash && record.vector.length === record.dimensions && record.dimensions > 0);
}

export async function ensureSemanticIndex(blocks: UnifiedSourceBlock[], provider: EmbeddingProvider, options: SemanticIndexOptions = {}): Promise<EmbeddingRecord[]> {
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 16, 64));
  const existing = await knowledgeDb.embeddings.where("modelId").equals(provider.id).toArray();
  const byId = new Map(existing.map((record) => [record.id, record]));
  const hashes = new Map<string, string>();
  const stale: UnifiedSourceBlock[] = [];
  let reused = 0;
  for (const block of blocks) {
    if (options.signal?.aborted) throw new DOMException("Semantic indexing cancelled.", "AbortError");
    const hash = await semanticContentHash(block);
    hashes.set(block.id, hash);
    const record = byId.get(embeddingRecordId(provider, block.id));
    if (isEmbeddingFresh(record, provider, hash)) reused += 1;
    else stale.push(block);
  }
  options.onProgress?.({ completed: reused, total: blocks.length, reused, created: 0 });
  let created = 0;
  for (let offset = 0; offset < stale.length; offset += batchSize) {
    if (options.signal?.aborted) throw new DOMException("Semantic indexing cancelled.", "AbortError");
    const batch = stale.slice(offset, offset + batchSize);
    const vectors = await provider.embed(batch.map(semanticInput), { signal: options.signal });
    if (vectors.length !== batch.length) throw new Error("Embedding provider returned an unexpected vector count.");
    const now = new Date().toISOString();
    const records = batch.map((block, index): EmbeddingRecord => ({
      id: embeddingRecordId(provider, block.id),
      blockId: block.id,
      modelId: provider.id,
      modelVersion: provider.version,
      contentHash: hashes.get(block.id)!,
      dimensions: vectors[index].length,
      vector: vectors[index],
      createdAt: now
    }));
    if (records.some((record) => !record.dimensions || record.vector.some((value) => !Number.isFinite(value)))) throw new Error("Embedding provider produced an invalid vector.");
    await knowledgeDb.embeddings.bulkPut(records);
    records.forEach((record) => byId.set(record.id, record));
    created += records.length;
    options.onProgress?.({ completed: reused + created, total: blocks.length, reused, created });
  }
  const liveBlockIds = new Set(blocks.map((block) => block.id));
  const staleRecords = existing.filter((record) => record.modelId === provider.id && !liveBlockIds.has(record.blockId));
  if (staleRecords.length) await knowledgeDb.embeddings.bulkDelete(staleRecords.map((record) => record.id));
  return blocks.map((block) => byId.get(embeddingRecordId(provider, block.id))).filter((record): record is EmbeddingRecord => Boolean(record));
}

export async function cachedVectorRank(query: string, blocks: UnifiedSourceBlock[], provider: EmbeddingProvider, limit = 20, signal?: AbortSignal): Promise<{ block: UnifiedSourceBlock; score: number }[]> {
  if (!query.trim() || !blocks.length) return [];
  const [queryVector] = await provider.embed([query], { signal });
  const records = await knowledgeDb.embeddings.where("modelId").equals(provider.id).toArray();
  const recordByBlock = new Map(records.filter((record) => record.modelVersion === provider.version).map((record) => [record.blockId, record]));
  return blocks.flatMap((block) => {
    const record = recordByBlock.get(block.id);
    if (!record || record.dimensions !== queryVector.length) return [];
    const score = cosineSimilarity(queryVector, record.vector);
    return Number.isFinite(score) && score > 0 ? [{ block, score }] : [];
  }).sort((left, right) => right.score - left.score || left.block.id.localeCompare(right.block.id)).slice(0, limit);
}

export async function hybridRetrieveCached(
  query: string,
  blocks: UnifiedSourceBlock[],
  entities: EntityCandidateRecord[],
  relations: RelationCandidateRecord[],
  provider: EmbeddingProvider | undefined,
  limit = 10,
  signal?: AbortSignal
): Promise<RankedEvidence[]> {
  const channelLimit = Math.max(20, limit * 3);
  const bm25 = bm25Rank(query, blocks, channelLimit);
  const graph = graphRank(query, blocks, entities, relations, channelLimit);
  let vector: { block: UnifiedSourceBlock; score: number }[] = [];
  if (provider) {
    await ensureSemanticIndex(blocks, provider, { signal });
    vector = await cachedVectorRank(query, blocks, provider, channelLimit, signal);
  }
  return reciprocalRankFusion({ bm25, vector, graph }, limit);
}
