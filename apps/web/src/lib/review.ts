import { knowledgeDb, type EntityCandidateRecord, type RelationCandidateRecord, type ReviewAuditRecord, type ReviewStatus } from "./store";

const now = () => new Date().toISOString();
const auditId = () => crypto.randomUUID();
const normalize = (value: string) => value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
const entityId = (type: EntityCandidateRecord["entityType"], value: string) => `entity-${type}-${normalize(value).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 80)}`;

function auditFor(record: EntityCandidateRecord | RelationCandidateRecord, targetKind: "entity" | "relation", action: ReviewAuditRecord["action"], previousStatus?: ReviewStatus, nextStatus?: ReviewStatus, beforeJson?: string, afterJson?: string): ReviewAuditRecord {
  return { id: auditId(), targetKind, targetId: record.id, action, previousStatus, nextStatus, extractorVersion: record.extractorVersion, evidenceBlockIds: [...record.evidenceBlockIds], beforeJson, afterJson, createdAt: now() };
}

export function reconcileEntityReview(previous: EntityCandidateRecord | undefined, next: EntityCandidateRecord): EntityCandidateRecord {
  if (!previous) return next;
  if (previous.extractorVersion !== next.extractorVersion) return { ...next, status: "pending", aliases: [...new Set([...next.aliases, ...previous.aliases])], pinned: previous.pinned };
  return { ...next, status: previous.status, aliases: [...new Set([...next.aliases, ...previous.aliases])], pinned: previous.pinned, mergedIntoId: previous.mergedIntoId };
}

export function reconcileRelationReview(previous: RelationCandidateRecord | undefined, next: RelationCandidateRecord): RelationCandidateRecord {
  if (!previous || previous.extractorVersion !== next.extractorVersion) return { ...next, status: "pending" };
  return { ...next, status: previous.status, validFrom: previous.validFrom ?? next.validFrom, validTo: previous.validTo ?? next.validTo };
}

export async function reviewEntity(record: EntityCandidateRecord, nextStatus: ReviewStatus): Promise<EntityCandidateRecord> {
  const updated = { ...record, status: nextStatus, updatedAt: now() };
  const action: ReviewAuditRecord["action"] = nextStatus === "accepted" ? "accept" : nextStatus === "rejected" ? "reject" : "reopen";
  await knowledgeDb.transaction("rw", [knowledgeDb.entities, knowledgeDb.reviewAudit], async () => {
    await knowledgeDb.entities.put(updated);
    await knowledgeDb.reviewAudit.add(auditFor(record, "entity", action, record.status, nextStatus, JSON.stringify(record), JSON.stringify(updated)));
  });
  return updated;
}

export async function reviewRelation(record: RelationCandidateRecord, nextStatus: ReviewStatus): Promise<RelationCandidateRecord> {
  const updated = { ...record, status: nextStatus, updatedAt: now() };
  const action: ReviewAuditRecord["action"] = nextStatus === "accepted" ? "accept" : nextStatus === "rejected" ? "reject" : "reopen";
  await knowledgeDb.transaction("rw", [knowledgeDb.relations, knowledgeDb.reviewAudit], async () => {
    await knowledgeDb.relations.put(updated);
    await knowledgeDb.reviewAudit.add(auditFor(record, "relation", action, record.status, nextStatus, JSON.stringify(record), JSON.stringify(updated)));
  });
  return updated;
}

export async function setRelationValidity(record: RelationCandidateRecord, validFrom?: string, validTo?: string): Promise<RelationCandidateRecord> {
  const cleanFrom = validFrom?.trim() || undefined;
  const cleanTo = validTo?.trim() || undefined;
  if (cleanFrom && Number.isNaN(Date.parse(cleanFrom))) throw new Error("validFrom must be an ISO-compatible date.");
  if (cleanTo && Number.isNaN(Date.parse(cleanTo))) throw new Error("validTo must be an ISO-compatible date.");
  if (cleanFrom && cleanTo && Date.parse(cleanFrom) > Date.parse(cleanTo)) throw new Error("validFrom cannot be after validTo.");
  const updated: RelationCandidateRecord = { ...record, validFrom: cleanFrom, validTo: cleanTo, updatedAt: now() };
  await knowledgeDb.transaction("rw", [knowledgeDb.relations, knowledgeDb.reviewAudit], async () => {
    await knowledgeDb.relations.put(updated);
    await knowledgeDb.reviewAudit.add(auditFor(record, "relation", "edit-validity", record.status, updated.status, JSON.stringify(record), JSON.stringify(updated)));
  });
  return updated;
}

export async function renameEntity(record: EntityCandidateRecord, canonicalName: string): Promise<EntityCandidateRecord> {
  const name = canonicalName.trim();
  if (!name) throw new Error("Entity name cannot be empty.");
  const updated: EntityCandidateRecord = { ...record, canonicalName: name, normalizedName: normalize(name), aliases: [...new Set([...record.aliases, record.canonicalName])], updatedAt: now() };
  await knowledgeDb.transaction("rw", [knowledgeDb.entities, knowledgeDb.reviewAudit], async () => {
    await knowledgeDb.entities.put(updated);
    await knowledgeDb.reviewAudit.add(auditFor(record, "entity", "rename", record.status, updated.status, JSON.stringify(record), JSON.stringify(updated)));
  });
  return updated;
}

export async function setEntityPinned(record: EntityCandidateRecord, pinned: boolean): Promise<EntityCandidateRecord> {
  const updated = { ...record, pinned, updatedAt: now() };
  await knowledgeDb.transaction("rw", [knowledgeDb.entities, knowledgeDb.reviewAudit], async () => {
    await knowledgeDb.entities.put(updated);
    await knowledgeDb.reviewAudit.add(auditFor(record, "entity", pinned ? "pin" : "unpin", record.status, updated.status, JSON.stringify(record), JSON.stringify(updated)));
  });
  return updated;
}

export async function mergeEntities(primary: EntityCandidateRecord, secondary: EntityCandidateRecord): Promise<EntityCandidateRecord> {
  if (primary.id === secondary.id) throw new Error("An entity cannot be merged into itself.");
  const updated: EntityCandidateRecord = {
    ...primary,
    aliases: [...new Set([...primary.aliases, secondary.canonicalName, ...secondary.aliases])],
    evidenceBlockIds: [...new Set([...primary.evidenceBlockIds, ...secondary.evidenceBlockIds])],
    confidence: Math.max(primary.confidence, secondary.confidence),
    updatedAt: now()
  };
  const mergedSecondary: EntityCandidateRecord = { ...secondary, mergedIntoId: primary.id, status: "rejected", updatedAt: now() };
  const affectedRelations = await knowledgeDb.relations.filter((relation) => relation.sourceEntityId === secondary.id || relation.targetEntityId === secondary.id).toArray();
  const rewritten = affectedRelations.map((relation) => ({
    ...relation,
    sourceEntityId: relation.sourceEntityId === secondary.id ? primary.id : relation.sourceEntityId,
    targetEntityId: relation.targetEntityId === secondary.id ? primary.id : relation.targetEntityId,
    id: `${relation.sourceEntityId === secondary.id ? primary.id : relation.sourceEntityId}::${relation.relation}::${relation.targetEntityId === secondary.id ? primary.id : relation.targetEntityId}`,
    updatedAt: now()
  })).filter((relation) => relation.sourceEntityId !== relation.targetEntityId);
  await knowledgeDb.transaction("rw", [knowledgeDb.entities, knowledgeDb.relations, knowledgeDb.reviewAudit], async () => {
    await knowledgeDb.entities.bulkPut([updated, mergedSecondary]);
    await knowledgeDb.relations.bulkDelete(affectedRelations.map((relation) => relation.id));
    await knowledgeDb.relations.bulkPut(rewritten);
    await knowledgeDb.reviewAudit.add(auditFor(primary, "entity", "merge", primary.status, updated.status, JSON.stringify({ primary, secondary, affectedRelations }), JSON.stringify({ primary: updated, secondary: mergedSecondary, rewritten })));
  });
  return updated;
}

export async function splitEntity(record: EntityCandidateRecord, newName: string, evidenceBlockIds: string[]): Promise<EntityCandidateRecord> {
  const selected = [...new Set(evidenceBlockIds)].filter((id) => record.evidenceBlockIds.includes(id));
  if (!selected.length || selected.length >= record.evidenceBlockIds.length) throw new Error("A split must move some, but not all, evidence blocks.");
  const name = newName.trim();
  if (!name) throw new Error("Split entity name cannot be empty.");
  const created: EntityCandidateRecord = {
    ...record,
    id: `${entityId(record.entityType, name)}-${crypto.randomUUID().slice(0, 8)}`,
    canonicalName: name,
    normalizedName: normalize(name),
    aliases: [],
    evidenceBlockIds: selected,
    status: "pending",
    pinned: false,
    mergedIntoId: undefined,
    updatedAt: now()
  };
  const remaining = { ...record, evidenceBlockIds: record.evidenceBlockIds.filter((id) => !selected.includes(id)), updatedAt: now() };
  await knowledgeDb.transaction("rw", [knowledgeDb.entities, knowledgeDb.reviewAudit], async () => {
    await knowledgeDb.entities.bulkPut([remaining, created]);
    await knowledgeDb.reviewAudit.add(auditFor(record, "entity", "split", record.status, record.status, JSON.stringify(record), JSON.stringify({ remaining, created })));
  });
  return created;
}
