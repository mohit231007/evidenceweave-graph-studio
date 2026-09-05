export interface RetrievalEvalCase {
  id: string;
  relevantIds: string[];
  rankedIds: string[];
}

export interface RetrievalMetrics {
  recallAtK: number;
  mrr: number;
  ndcgAtK: number;
}

export function recallAtK(relevant: string[], ranked: string[], k: number): number {
  if (!relevant.length) return 1;
  const retrieved = new Set(ranked.slice(0, k));
  return relevant.filter((id) => retrieved.has(id)).length / relevant.length;
}

export function reciprocalRank(relevant: string[], ranked: string[]): number {
  const targets = new Set(relevant);
  const index = ranked.findIndex((id) => targets.has(id));
  return index < 0 ? 0 : 1 / (index + 1);
}

export function ndcgAtK(relevant: string[], ranked: string[], k: number): number {
  const targets = new Set(relevant);
  let dcg = 0;
  ranked.slice(0, k).forEach((id, index) => { if (targets.has(id)) dcg += 1 / Math.log2(index + 2); });
  let ideal = 0;
  for (let index = 0; index < Math.min(k, relevant.length); index += 1) ideal += 1 / Math.log2(index + 2);
  return ideal ? dcg / ideal : 1;
}

export function evaluateRetrieval(cases: RetrievalEvalCase[], k = 10): RetrievalMetrics {
  if (!cases.length) return { recallAtK: 0, mrr: 0, ndcgAtK: 0 };
  const aggregate = cases.reduce((sum, item) => ({
    recallAtK: sum.recallAtK + recallAtK(item.relevantIds, item.rankedIds, k),
    mrr: sum.mrr + reciprocalRank(item.relevantIds, item.rankedIds),
    ndcgAtK: sum.ndcgAtK + ndcgAtK(item.relevantIds, item.rankedIds, k)
  }), { recallAtK: 0, mrr: 0, ndcgAtK: 0 });
  return { recallAtK: aggregate.recallAtK / cases.length, mrr: aggregate.mrr / cases.length, ndcgAtK: aggregate.ndcgAtK / cases.length };
}

export function pathRecall(expectedEdges: string[], retrievedEdges: string[]): number {
  if (!expectedEdges.length) return 1;
  const actual = new Set(retrievedEdges);
  return expectedEdges.filter((edge) => actual.has(edge)).length / expectedEdges.length;
}
