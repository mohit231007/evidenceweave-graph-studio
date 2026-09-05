import type { EntityCandidateRecord, RelationCandidateRecord } from "./store";
import type { UnifiedSourceBlock } from "./hybrid";

export const ENTITY_EXTRACTOR_VERSION = "deterministic-entity-v1";
export const RELATION_EXTRACTOR_VERSION = "deterministic-relation-v1";

const normalize = (value: string) => value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
const idFor = (prefix: string, value: string) => `${prefix}-${normalize(value).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 80)}`;

interface RawCandidate {
  name: string;
  type: EntityCandidateRecord["entityType"];
  confidence: number;
}

function candidatesInText(text: string): RawCandidate[] {
  const candidates: RawCandidate[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s)\]}>,]+/giu)) candidates.push({ name: match[0], type: "url", confidence: 0.99 });
  for (const match of text.matchAll(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/giu)) candidates.push({ name: match[0], type: "identifier", confidence: 0.99 });
  for (const match of text.matchAll(/\b(?:ISBN(?:-1[03])?:?\s*)?(?:97[89][- ]?)?\d(?:[- ]?\d){8,12}[\dX]\b/giu)) {
    if (/ISBN/i.test(match[0])) candidates.push({ name: match[0], type: "identifier", confidence: 0.96 });
  }
  for (const match of text.matchAll(/\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b/g)) candidates.push({ name: match[0], type: "date", confidence: 0.98 });
  for (const match of text.matchAll(/\b(?:[A-Z][\p{L}\p{N}&.-]+(?:\s+|$)){2,5}/gu)) {
    const name = match[0].trim();
    if (name.length >= 5 && name.length <= 100) candidates.push({ name, type: "topic", confidence: 0.62 });
  }
  return candidates;
}

export function extractEntityCandidates(blocks: UnifiedSourceBlock[]): EntityCandidateRecord[] {
  const byName = new Map<string, EntityCandidateRecord>();
  const stamp = new Date().toISOString();
  for (const block of blocks) {
    const headingCandidates = block.headingPath.map((name) => ({ name, type: "topic" as const, confidence: 0.86 }));
    for (const candidate of [...headingCandidates, ...candidatesInText(block.text)]) {
      const key = `${candidate.type}:${normalize(candidate.name)}`;
      const existing = byName.get(key);
      if (existing) {
        if (!existing.evidenceBlockIds.includes(block.id)) existing.evidenceBlockIds.push(block.id);
        existing.confidence = Math.max(existing.confidence, candidate.confidence);
        continue;
      }
      byName.set(key, {
        id: idFor(`entity-${candidate.type}`, candidate.name),
        canonicalName: candidate.name,
        normalizedName: normalize(candidate.name),
        entityType: candidate.type,
        evidenceBlockIds: [block.id],
        confidence: candidate.confidence,
        extractorVersion: ENTITY_EXTRACTOR_VERSION,
        status: "pending",
        aliases: [],
        updatedAt: stamp
      });
    }
  }
  return [...byName.values()].sort((left, right) => right.confidence - left.confidence || left.canonicalName.localeCompare(right.canonicalName));
}

function relationVerb(text: string, left: string, right: string): { relation: string; confidence: number } | undefined {
  const lower = text.toLocaleLowerCase();
  const a = lower.indexOf(left.toLocaleLowerCase());
  const b = lower.indexOf(right.toLocaleLowerCase(), Math.max(0, a + left.length));
  if (a < 0 || b < 0) return undefined;
  const between = lower.slice(a + left.length, b).slice(0, 120);
  const patterns: [RegExp, string, number][] = [
    [/\bacquir(?:ed|es|ing)\b/, "acquired", 0.93],
    [/\bpartner(?:ed|s|ing)?\s+(?:with)?\b/, "partnered-with", 0.88],
    [/\buses?\b/, "uses", 0.84],
    [/\bdepends?\s+on\b/, "depends-on", 0.88],
    [/\bworks?\s+(?:at|for)\b/, "works-at", 0.82],
    [/\b(?:is|was)\s+(?:part|member)\s+of\b/, "part-of", 0.84],
    [/\bcreated?\b|\bbuilt\b|\bdeveloped?\b/, "created", 0.76]
  ];
  for (const [pattern, relation, confidence] of patterns) if (pattern.test(between)) return { relation, confidence };
  return { relation: "mentioned-with", confidence: 0.45 };
}

export function extractRelationCandidates(blocks: UnifiedSourceBlock[], entities: EntityCandidateRecord[]): RelationCandidateRecord[] {
  const byId = new Map<string, RelationCandidateRecord>();
  const stamp = new Date().toISOString();
  const entityByBlock = new Map<string, EntityCandidateRecord[]>();
  for (const entity of entities) {
    for (const blockId of entity.evidenceBlockIds) {
      const list = entityByBlock.get(blockId) ?? [];
      list.push(entity);
      entityByBlock.set(blockId, list);
    }
  }
  for (const block of blocks) {
    const candidates = (entityByBlock.get(block.id) ?? []).filter((entity) => entity.entityType !== "url" && entity.entityType !== "identifier").slice(0, 12);
    for (let left = 0; left < candidates.length; left += 1) {
      for (let right = left + 1; right < candidates.length; right += 1) {
        const relation = relationVerb(block.text, candidates[left].canonicalName, candidates[right].canonicalName);
        if (!relation) continue;
        const id = `${candidates[left].id}::${relation.relation}::${candidates[right].id}`;
        const existing = byId.get(id);
        if (existing) {
          if (!existing.evidenceBlockIds.includes(block.id)) existing.evidenceBlockIds.push(block.id);
          existing.confidence = Math.max(existing.confidence, relation.confidence);
          continue;
        }
        byId.set(id, {
          id,
          sourceEntityId: candidates[left].id,
          targetEntityId: candidates[right].id,
          relation: relation.relation,
          evidenceBlockIds: [block.id],
          confidence: relation.confidence,
          extractorVersion: RELATION_EXTRACTOR_VERSION,
          status: "pending",
          observedAt: stamp,
          updatedAt: stamp
        });
      }
    }
  }
  return [...byId.values()].sort((left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id));
}

export function updateReviewStatus<T extends EntityCandidateRecord | RelationCandidateRecord>(record: T, status: T["status"]): T {
  return { ...record, status, updatedAt: new Date().toISOString() };
}
