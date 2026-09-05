import { knowledgeDb, type EntityCandidateRecord, type RelationCandidateRecord, type ReviewAuditRecord } from "./store";

const parse = <T>(value?: string): T | undefined => value ? JSON.parse(value) as T : undefined;

function undoMarker(original: ReviewAuditRecord): ReviewAuditRecord {
  return {
    id: crypto.randomUUID(),
    targetKind: original.targetKind,
    targetId: original.targetId,
    action: "undo",
    previousStatus: original.nextStatus,
    nextStatus: original.previousStatus,
    extractorVersion: original.extractorVersion,
    evidenceBlockIds: [...original.evidenceBlockIds],
    beforeJson: JSON.stringify({ originalAuditId: original.id, action: original.action }),
    afterJson: original.beforeJson,
    createdAt: new Date().toISOString()
  };
}

async function alreadyUndone(auditId: string): Promise<boolean> {
  const undoEvents = await knowledgeDb.reviewAudit.where("action").equals("undo").toArray();
  return undoEvents.some((event) => {
    try { return (parse<{ originalAuditId?: string }>(event.beforeJson)?.originalAuditId) === auditId; }
    catch { return false; }
  });
}

export async function undoReviewAudit(auditId: string): Promise<void> {
  const audit = await knowledgeDb.reviewAudit.get(auditId);
  if (!audit) throw new Error("Review audit event was not found.");
  if (audit.action === "undo") throw new Error("Undo events cannot be undone recursively.");
  if (await alreadyUndone(audit.id)) throw new Error("This review action has already been undone.");
  if (!audit.beforeJson) throw new Error("This audit event does not contain a reversible before snapshot.");

  if (audit.targetKind === "relation") {
    const before = parse<RelationCandidateRecord>(audit.beforeJson);
    if (!before?.id) throw new Error("Relation audit snapshot is malformed.");
    await knowledgeDb.transaction("rw", [knowledgeDb.relations, knowledgeDb.reviewAudit], async () => {
      await knowledgeDb.relations.put(before);
      await knowledgeDb.reviewAudit.add(undoMarker(audit));
    });
    return;
  }

  if (audit.action === "merge") {
    const before = parse<{ primary: EntityCandidateRecord; secondary: EntityCandidateRecord; affectedRelations: RelationCandidateRecord[] }>(audit.beforeJson);
    const after = parse<{ primary: EntityCandidateRecord; secondary: EntityCandidateRecord; rewritten: RelationCandidateRecord[] }>(audit.afterJson);
    if (!before?.primary?.id || !before.secondary?.id || !Array.isArray(before.affectedRelations)) throw new Error("Merge audit snapshot is malformed.");
    await knowledgeDb.transaction("rw", [knowledgeDb.entities, knowledgeDb.relations, knowledgeDb.reviewAudit], async () => {
      await knowledgeDb.entities.bulkPut([before.primary, before.secondary]);
      if (after?.rewritten?.length) await knowledgeDb.relations.bulkDelete(after.rewritten.map((relation) => relation.id));
      if (before.affectedRelations.length) await knowledgeDb.relations.bulkPut(before.affectedRelations);
      await knowledgeDb.reviewAudit.add(undoMarker(audit));
    });
    return;
  }

  if (audit.action === "split") {
    const before = parse<EntityCandidateRecord>(audit.beforeJson);
    const after = parse<{ remaining: EntityCandidateRecord; created: EntityCandidateRecord }>(audit.afterJson);
    if (!before?.id || !after?.created?.id) throw new Error("Split audit snapshot is malformed.");
    await knowledgeDb.transaction("rw", [knowledgeDb.entities, knowledgeDb.reviewAudit], async () => {
      await knowledgeDb.entities.put(before);
      await knowledgeDb.entities.delete(after.created.id);
      await knowledgeDb.reviewAudit.add(undoMarker(audit));
    });
    return;
  }

  const before = parse<EntityCandidateRecord>(audit.beforeJson);
  if (!before?.id) throw new Error("Entity audit snapshot is malformed.");
  await knowledgeDb.transaction("rw", [knowledgeDb.entities, knowledgeDb.reviewAudit], async () => {
    await knowledgeDb.entities.put(before);
    await knowledgeDb.reviewAudit.add(undoMarker(audit));
  });
}
