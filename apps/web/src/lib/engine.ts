import { bm25Rank, graphRank, reciprocalRankFusion, type EmbeddingProvider, type RankedEvidence, type UnifiedSourceBlock } from "./hybrid";
import { buildRelationProofs, connectedComponents, relationMatchesTemporal, type QueryRoute, type RelationPathProof } from "./reasoning";
import { cachedVectorRank, ensureSemanticIndex, type SemanticIndexOptions } from "./semantic";
import { knowledgeDb, type EntityCandidateRecord, type QueryTraceRecord, type RelationCandidateRecord } from "./store";

export const EVIDENCE_ENGINE_VERSION = "evidence-engine-v2";

export interface EvidenceQueryTrace {
  id: string;
  question: string;
  createdAt: string;
  retrievalVersion: string;
  route: QueryRoute;
  paths: RelationPathProof[];
  components: string[][];
  results: {
    blockId: string;
    sourceType: "note" | "document";
    sourceId: string;
    fusedScore: number;
    ranks: RankedEvidence["ranks"];
    scores: RankedEvidence["scores"];
  }[];
  diagnostics: {
    blockCount: number;
    acceptedEntityCount: number;
    acceptedRelationCount: number;
    semanticEnabled: boolean;
    missingPathPairs: string[];
  };
}

export interface EvidenceQueryResult {
  evidence: RankedEvidence[];
  trace: EvidenceQueryTrace;
}

function temporalGraphRank(
  question: string,
  blocks: UnifiedSourceBlock[],
  entities: EntityCandidateRecord[],
  relations: RelationCandidateRecord[],
  route: QueryRoute,
  paths: RelationPathProof[],
  limit: number
): { block: UnifiedSourceBlock; score: number }[] {
  const filteredRelations = route.temporal ? relations.filter((relation) => relationMatchesTemporal(relation, route.temporal)) : relations;
  const baseline = graphRank(question, blocks, entities, filteredRelations, limit);
  const pathEvidence = new Map<string, number>();
  for (const path of paths) {
    path.hops.forEach((hop, hopIndex) => {
      for (const blockId of hop.evidenceBlockIds) {
        const pathScore = Math.max(0.7, 1 - hopIndex * 0.08);
        pathEvidence.set(blockId, Math.max(pathEvidence.get(blockId) ?? 0, pathScore));
      }
    });
  }
  const combined = new Map(baseline.map((hit) => [hit.block.id, hit]));
  for (const block of blocks) {
    const score = pathEvidence.get(block.id);
    if (!score) continue;
    const existing = combined.get(block.id);
    combined.set(block.id, { block, score: Math.max(existing?.score ?? 0, score) });
  }
  return [...combined.values()].sort((left, right) => right.score - left.score || left.block.id.localeCompare(right.block.id)).slice(0, limit);
}

export async function runEvidenceQuery(args: {
  question: string;
  blocks: UnifiedSourceBlock[];
  entities?: EntityCandidateRecord[];
  relations?: RelationCandidateRecord[];
  provider?: EmbeddingProvider;
  limit?: number;
  persistTrace?: boolean;
  semanticProgress?: SemanticIndexOptions["onProgress"];
}): Promise<EvidenceQueryResult> {
  const question = args.question.trim();
  if (!question) throw new Error("Question cannot be empty.");
  const entities = args.entities ?? [];
  const relations = args.relations ?? [];
  const limit = Math.max(1, Math.min(args.limit ?? 10, 50));
  const channelLimit = Math.max(20, limit * 3);
  const proof = buildRelationProofs(question, entities, relations, 4);
  const bm25 = bm25Rank(question, args.blocks, channelLimit);
  const graph = temporalGraphRank(question, args.blocks, entities, relations, proof.route, proof.paths, channelLimit);
  let vector: { block: UnifiedSourceBlock; score: number }[] = [];
  if (args.provider) {
    await ensureSemanticIndex(args.blocks, args.provider, { onProgress: args.semanticProgress });
    vector = await cachedVectorRank(question, args.blocks, args.provider, channelLimit);
  }
  const evidence = reciprocalRankFusion({ bm25, vector, graph }, limit);
  const expectedPairs: string[] = [];
  for (let left = 0; left < proof.route.anchorEntityIds.length; left += 1) {
    for (let right = left + 1; right < proof.route.anchorEntityIds.length; right += 1) expectedPairs.push(`${proof.route.anchorEntityIds[left]}↔${proof.route.anchorEntityIds[right]}`);
  }
  const resolvedPairs = new Set(proof.paths.map((path) => `${path.sourceEntityId}↔${path.targetEntityId}`));
  const trace: EvidenceQueryTrace = {
    id: crypto.randomUUID(),
    question,
    createdAt: new Date().toISOString(),
    retrievalVersion: EVIDENCE_ENGINE_VERSION,
    route: proof.route,
    paths: proof.paths,
    components: connectedComponents(entities, relations),
    results: evidence.map((hit) => ({ blockId: hit.block.id, sourceType: hit.block.sourceType, sourceId: hit.block.sourceId, fusedScore: hit.fusedScore, ranks: hit.ranks, scores: hit.scores })),
    diagnostics: {
      blockCount: args.blocks.length,
      acceptedEntityCount: entities.filter((entity) => entity.status === "accepted" && !entity.mergedIntoId).length,
      acceptedRelationCount: relations.filter((relation) => relation.status === "accepted").length,
      semanticEnabled: Boolean(args.provider),
      missingPathPairs: expectedPairs.filter((pair) => !resolvedPairs.has(pair))
    }
  };
  if (args.persistTrace !== false) {
    const record: QueryTraceRecord = { id: trace.id, question, mode: trace.route.mode, retrievalVersion: trace.retrievalVersion, payload: JSON.stringify(trace), createdAt: trace.createdAt };
    await knowledgeDb.queryTraces.put(record);
  }
  return { evidence, trace };
}

export function validateRelationProofs(paths: RelationPathProof[], blocks: UnifiedSourceBlock[]): { valid: boolean; missingBlockIds: string[]; emptyEvidenceHopIds: string[] } {
  const blockIds = new Set(blocks.map((block) => block.id));
  const missingBlockIds = new Set<string>();
  const emptyEvidenceHopIds: string[] = [];
  for (const path of paths) {
    for (const hop of path.hops) {
      if (!hop.evidenceBlockIds.length) emptyEvidenceHopIds.push(hop.relationId);
      for (const blockId of hop.evidenceBlockIds) if (!blockIds.has(blockId)) missingBlockIds.add(blockId);
    }
  }
  return { valid: missingBlockIds.size === 0 && emptyEvidenceHopIds.length === 0, missingBlockIds: [...missingBlockIds].sort(), emptyEvidenceHopIds: [...new Set(emptyEvidenceHopIds)].sort() };
}
