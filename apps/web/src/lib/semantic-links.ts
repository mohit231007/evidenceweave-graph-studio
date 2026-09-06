import { cosineSimilarity, type EmbeddingProvider } from "./hybrid";
import { knowledgeDb, type EntityCandidateRecord, type SemanticLinkSuggestionRecord } from "./store";

export interface SemanticLinkOptions {
  threshold?: number;
  maxEntities?: number;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
}

export async function buildSemanticLinkSuggestions(
  entities: EntityCandidateRecord[],
  provider: EmbeddingProvider,
  options: SemanticLinkOptions = {}
): Promise<SemanticLinkSuggestionRecord[]> {
  const threshold = Math.max(0.5, Math.min(options.threshold ?? 0.72, 0.99));
  const maxEntities = Math.max(2, Math.min(options.maxEntities ?? 250, 500));
  const accepted = entities
    .filter((entity) => entity.status === "accepted" && !entity.mergedIntoId)
    .sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || right.evidenceBlockIds.length - left.evidenceBlockIds.length || left.id.localeCompare(right.id))
    .slice(0, maxEntities);
  if (accepted.length < 2) {
    await knowledgeDb.semanticSuggestions.clear();
    return [];
  }
  if (options.signal?.aborted) throw new DOMException("Semantic-link analysis cancelled.", "AbortError");
  const vectors = await provider.embed(accepted.map((entity) => `${entity.entityType}: ${entity.canonicalName}\nAliases: ${entity.aliases.join(", ")}`), { signal: options.signal });
  if (vectors.length !== accepted.length) throw new Error("Embedding provider returned an unexpected semantic-link vector count.");

  const total = accepted.length * (accepted.length - 1) / 2;
  let completed = 0;
  const suggestions: SemanticLinkSuggestionRecord[] = [];
  const now = new Date().toISOString();
  for (let left = 0; left < accepted.length; left += 1) {
    for (let right = left + 1; right < accepted.length; right += 1) {
      if (options.signal?.aborted) throw new DOMException("Semantic-link analysis cancelled.", "AbortError");
      completed += 1;
      const score = cosineSimilarity(vectors[left], vectors[right]);
      if (Number.isFinite(score) && score >= threshold) {
        const source = accepted[left];
        const target = accepted[right];
        const [sourceEntityId, targetEntityId] = [source.id, target.id].sort();
        suggestions.push({
          id: `semantic::${sourceEntityId}::${targetEntityId}::${provider.id}`,
          sourceEntityId,
          targetEntityId,
          score,
          evidenceBlockIds: [...new Set([...source.evidenceBlockIds, ...target.evidenceBlockIds])],
          modelId: provider.id,
          modelVersion: provider.version,
          status: "pending",
          updatedAt: now
        });
      }
      if (completed % 50 === 0 || completed === total) options.onProgress?.(completed, total);
    }
  }

  const previous = new Map((await knowledgeDb.semanticSuggestions.toArray()).map((item) => [item.id, item]));
  const reconciled = suggestions.map((suggestion) => {
    const old = previous.get(suggestion.id);
    return old && old.modelVersion === suggestion.modelVersion ? { ...suggestion, status: old.status } : suggestion;
  });
  await knowledgeDb.transaction("rw", knowledgeDb.semanticSuggestions, async () => {
    await knowledgeDb.semanticSuggestions.clear();
    if (reconciled.length) await knowledgeDb.semanticSuggestions.bulkPut(reconciled);
  });
  return reconciled.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

export async function reviewSemanticLink(id: string, status: SemanticLinkSuggestionRecord["status"]): Promise<SemanticLinkSuggestionRecord> {
  const current = await knowledgeDb.semanticSuggestions.get(id);
  if (!current) throw new Error("Semantic-link suggestion was not found.");
  const updated = { ...current, status, updatedAt: new Date().toISOString() };
  await knowledgeDb.semanticSuggestions.put(updated);
  return updated;
}
