import type { EntityCandidateRecord, RelationCandidateRecord } from "./store";

export type QueryMode = "exact" | "local" | "multi-hop" | "global" | "temporal";

export interface TemporalConstraint {
  fromYear?: number;
  toYear?: number;
  reason: string;
}

export interface QueryRoute {
  mode: QueryMode;
  reason: string;
  anchorEntityIds: string[];
  temporal?: TemporalConstraint;
}

export interface RelationPathHop {
  relationId: string;
  fromEntityId: string;
  toEntityId: string;
  traversal: "forward" | "reverse";
  relation: string;
  evidenceBlockIds: string[];
  validFrom?: string;
  validTo?: string;
}

export interface RelationPathProof {
  sourceEntityId: string;
  targetEntityId: string;
  hops: RelationPathHop[];
}

const year = (value?: string): number | undefined => {
  if (!value) return undefined;
  const match = value.match(/(?:19|20)\d{2}/);
  return match ? Number(match[0]) : undefined;
};

export function parseTemporalConstraint(question: string): TemporalConstraint | undefined {
  const text = question.toLocaleLowerCase();
  let match = text.match(/\bbetween\s+((?:19|20)\d{2})\s+(?:and|to)\s+((?:19|20)\d{2})\b/);
  if (match) return { fromYear: Math.min(Number(match[1]), Number(match[2])), toYear: Math.max(Number(match[1]), Number(match[2])), reason: match[0] };
  match = text.match(/\b(?:from)\s+((?:19|20)\d{2})\s+(?:to|through|until)\s+((?:19|20)\d{2})\b/);
  if (match) return { fromYear: Math.min(Number(match[1]), Number(match[2])), toYear: Math.max(Number(match[1]), Number(match[2])), reason: match[0] };
  match = text.match(/\bbefore\s+((?:19|20)\d{2})\b/);
  if (match) return { toYear: Number(match[1]) - 1, reason: match[0] };
  match = text.match(/\b(?:after|since)\s+((?:19|20)\d{2})\b/);
  if (match) return { fromYear: Number(match[1]), reason: match[0] };
  match = text.match(/\b(?:in|during)\s+((?:19|20)\d{2})\b/);
  if (match) return { fromYear: Number(match[1]), toYear: Number(match[1]), reason: match[0] };
  return undefined;
}

export function acceptedAnchors(question: string, entities: EntityCandidateRecord[]): EntityCandidateRecord[] {
  const lower = question.toLocaleLowerCase();
  return entities.filter((entity) => entity.status === "accepted" && !entity.mergedIntoId)
    .filter((entity) => [entity.canonicalName, ...entity.aliases].some((name) => name.length >= 3 && lower.includes(name.toLocaleLowerCase())))
    .sort((left, right) => right.canonicalName.length - left.canonicalName.length || left.id.localeCompare(right.id));
}

export function routeQuery(question: string, entities: EntityCandidateRecord[]): QueryRoute {
  const temporal = parseTemporalConstraint(question);
  const anchors = acceptedAnchors(question, entities);
  if (temporal) return { mode: "temporal", reason: `Temporal language detected: ${temporal.reason}`, anchorEntityIds: anchors.map((entity) => entity.id), temporal };
  if (anchors.length >= 2) return { mode: "multi-hop", reason: `${anchors.length} reviewed entities are named in the question.`, anchorEntityIds: anchors.map((entity) => entity.id) };
  if (anchors.length === 1) return { mode: "local", reason: `Question anchors on reviewed entity “${anchors[0].canonicalName}”.`, anchorEntityIds: [anchors[0].id] };
  if (/(["“]).+(["”])/.test(question)) return { mode: "exact", reason: "Quoted text indicates exact retrieval intent.", anchorEntityIds: [] };
  return { mode: "global", reason: "No reviewed entity or temporal anchor was found; use workspace-wide retrieval.", anchorEntityIds: [] };
}

export function relationMatchesTemporal(relation: RelationCandidateRecord, constraint?: TemporalConstraint): boolean {
  if (!constraint) return true;
  const from = year(relation.validFrom) ?? year(relation.observedAt);
  const to = year(relation.validTo) ?? from;
  if (from === undefined && to === undefined) return false;
  const effectiveFrom = from ?? to!;
  const effectiveTo = to ?? from!;
  if (constraint.fromYear !== undefined && effectiveTo < constraint.fromYear) return false;
  if (constraint.toYear !== undefined && effectiveFrom > constraint.toYear) return false;
  return true;
}

export function findAcceptedRelationPath(
  sourceEntityId: string,
  targetEntityId: string,
  relations: RelationCandidateRecord[],
  maxHops = 4,
  temporal?: TemporalConstraint
): RelationPathProof | undefined {
  if (sourceEntityId === targetEntityId) return { sourceEntityId, targetEntityId, hops: [] };
  const accepted = relations.filter((relation) => relation.status === "accepted" && relationMatchesTemporal(relation, temporal));
  const queue: { id: string; hops: RelationPathHop[] }[] = [{ id: sourceEntityId, hops: [] }];
  const visited = new Set([sourceEntityId]);
  while (queue.length) {
    const current = queue.shift()!;
    if (current.hops.length >= maxHops) continue;
    for (const relation of accepted) {
      let next: string | undefined;
      let traversal: "forward" | "reverse" = "forward";
      if (relation.sourceEntityId === current.id) next = relation.targetEntityId;
      else if (relation.targetEntityId === current.id) { next = relation.sourceEntityId; traversal = "reverse"; }
      if (!next || visited.has(next)) continue;
      const hop: RelationPathHop = {
        relationId: relation.id,
        fromEntityId: current.id,
        toEntityId: next,
        traversal,
        relation: relation.relation,
        evidenceBlockIds: [...relation.evidenceBlockIds],
        validFrom: relation.validFrom,
        validTo: relation.validTo
      };
      const hops = [...current.hops, hop];
      if (next === targetEntityId) return { sourceEntityId, targetEntityId, hops };
      visited.add(next);
      queue.push({ id: next, hops });
    }
  }
  return undefined;
}

export function connectedComponents(entities: EntityCandidateRecord[], relations: RelationCandidateRecord[]): string[][] {
  const acceptedEntityIds = new Set(entities.filter((entity) => entity.status === "accepted" && !entity.mergedIntoId).map((entity) => entity.id));
  const adjacency = new Map<string, Set<string>>([...acceptedEntityIds].map((id) => [id, new Set<string>()]));
  for (const relation of relations.filter((item) => item.status === "accepted")) {
    if (!acceptedEntityIds.has(relation.sourceEntityId) || !acceptedEntityIds.has(relation.targetEntityId)) continue;
    adjacency.get(relation.sourceEntityId)!.add(relation.targetEntityId);
    adjacency.get(relation.targetEntityId)!.add(relation.sourceEntityId);
  }
  const visited = new Set<string>();
  const components: string[][] = [];
  for (const id of [...acceptedEntityIds].sort()) {
    if (visited.has(id)) continue;
    const component: string[] = [];
    const queue = [id];
    visited.add(id);
    while (queue.length) {
      const current = queue.shift()!;
      component.push(current);
      for (const next of [...(adjacency.get(current) ?? [])].sort()) if (!visited.has(next)) { visited.add(next); queue.push(next); }
    }
    components.push(component.sort());
  }
  return components.sort((left, right) => right.length - left.length || left[0].localeCompare(right[0]));
}

export function buildRelationProofs(question: string, entities: EntityCandidateRecord[], relations: RelationCandidateRecord[], maxHops = 4): { route: QueryRoute; paths: RelationPathProof[] } {
  const route = routeQuery(question, entities);
  const paths: RelationPathProof[] = [];
  for (let left = 0; left < route.anchorEntityIds.length; left += 1) {
    for (let right = left + 1; right < route.anchorEntityIds.length; right += 1) {
      const path = findAcceptedRelationPath(route.anchorEntityIds[left], route.anchorEntityIds[right], relations, maxHops, route.temporal);
      if (path) paths.push(path);
    }
  }
  return { route, paths };
}
