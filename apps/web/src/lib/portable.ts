import { db, type NoteRecord } from "./core";
import { knowledgeDb, type CanvasRecord, type DocumentBlockRecord, type EntityCandidateRecord, type QueryTraceRecord, type RelationCandidateRecord, type ReviewAuditRecord, type SavedViewRecord, type SnapshotRecord, type SourceDocumentRecord, type TrashRecord } from "./store";

export interface PortableWorkspaceV1 {
  schemaVersion: 1;
  exportedAt: string;
  notes: NoteRecord[];
  documents: SourceDocumentRecord[];
  blocks: DocumentBlockRecord[];
  entities: EntityCandidateRecord[];
  relations: RelationCandidateRecord[];
  canvases: CanvasRecord[];
  views: SavedViewRecord[];
  trash: TrashRecord[];
  snapshots: SnapshotRecord[];
}

export interface PortableWorkspaceV2 extends Omit<PortableWorkspaceV1, "schemaVersion"> {
  schemaVersion: 2;
  embeddingPolicy: "rebuild-on-device";
  reviewAudit: ReviewAuditRecord[];
  queryTraces: QueryTraceRecord[];
}

export type PortableWorkspace = PortableWorkspaceV1 | PortableWorkspaceV2;
type PortableCandidate = Partial<Omit<PortableWorkspaceV2, "schemaVersion">> & { schemaVersion?: number; reviewAudit?: ReviewAuditRecord[]; queryTraces?: QueryTraceRecord[] };

const requiredArrays = ["notes", "documents", "blocks", "entities", "relations", "canvases", "views", "trash", "snapshots"] as const;

export function validatePortableWorkspace(value: unknown): PortableWorkspaceV2 {
  if (!value || typeof value !== "object") throw new Error("Workspace bundle must be an object.");
  const candidate = value as PortableCandidate;
  if (candidate.schemaVersion !== 1 && candidate.schemaVersion !== 2) throw new Error("Unsupported EvidenceWeave workspace schema.");
  for (const key of requiredArrays) if (!Array.isArray(candidate[key])) throw new Error(`Workspace bundle is missing ${key}.`);
  const ids = new Set<string>();
  for (const note of candidate.notes!) {
    if (!note || typeof note.id !== "string" || typeof note.title !== "string" || typeof note.markdown !== "string") throw new Error("Workspace contains a malformed note.");
    if (ids.has(note.id)) throw new Error(`Duplicate note id: ${note.id}`);
    ids.add(note.id);
  }
  const documentIds = new Set(candidate.documents!.map((document) => document.id));
  for (const block of candidate.blocks!) if (!documentIds.has(block.documentId)) throw new Error(`Orphan document block: ${block.id}`);
  const entityIds = new Set(candidate.entities!.map((entity) => entity.id));
  for (const relation of candidate.relations!) {
    if (!entityIds.has(relation.sourceEntityId) || !entityIds.has(relation.targetEntityId)) throw new Error(`Orphan inferred relation: ${relation.id}`);
    if (!relation.evidenceBlockIds.length) throw new Error(`Relation lacks provenance: ${relation.id}`);
  }
  return {
    schemaVersion: 2,
    embeddingPolicy: "rebuild-on-device",
    exportedAt: candidate.exportedAt ?? new Date().toISOString(),
    notes: candidate.notes!, documents: candidate.documents!, blocks: candidate.blocks!, entities: candidate.entities!, relations: candidate.relations!, canvases: candidate.canvases!, views: candidate.views!, trash: candidate.trash!, snapshots: candidate.snapshots!,
    reviewAudit: Array.isArray(candidate.reviewAudit) ? candidate.reviewAudit : [],
    queryTraces: Array.isArray(candidate.queryTraces) ? candidate.queryTraces : []
  };
}

export async function exportPortableWorkspace(notes: NoteRecord[]): Promise<PortableWorkspaceV2> {
  const [documents, blocks, entities, relations, canvases, views, trash, snapshots, reviewAudit, queryTraces] = await Promise.all([
    knowledgeDb.documents.toArray(), knowledgeDb.blocks.toArray(), knowledgeDb.entities.toArray(), knowledgeDb.relations.toArray(), knowledgeDb.canvases.toArray(), knowledgeDb.views.toArray(), knowledgeDb.trash.toArray(), knowledgeDb.snapshots.toArray(), knowledgeDb.reviewAudit.toArray(), knowledgeDb.queryTraces.toArray()
  ]);
  return { schemaVersion: 2, embeddingPolicy: "rebuild-on-device", exportedAt: new Date().toISOString(), notes, documents, blocks, entities, relations, canvases, views, trash, snapshots, reviewAudit, queryTraces };
}

export async function restorePortableWorkspace(input: PortableWorkspace): Promise<void> {
  const bundle = validatePortableWorkspace(input);
  await Promise.all([
    db.transaction("rw", db.notes, async () => { await db.notes.clear(); await db.notes.bulkPut(bundle.notes); }),
    knowledgeDb.transaction("rw", [knowledgeDb.documents, knowledgeDb.blocks, knowledgeDb.entities, knowledgeDb.relations, knowledgeDb.embeddings, knowledgeDb.canvases, knowledgeDb.views, knowledgeDb.trash, knowledgeDb.snapshots, knowledgeDb.reviewAudit, knowledgeDb.queryTraces], async () => {
      await Promise.all([
        knowledgeDb.documents.clear(), knowledgeDb.blocks.clear(), knowledgeDb.entities.clear(), knowledgeDb.relations.clear(), knowledgeDb.embeddings.clear(), knowledgeDb.canvases.clear(), knowledgeDb.views.clear(), knowledgeDb.trash.clear(), knowledgeDb.snapshots.clear(), knowledgeDb.reviewAudit.clear(), knowledgeDb.queryTraces.clear()
      ]);
      await knowledgeDb.documents.bulkPut(bundle.documents);
      await knowledgeDb.blocks.bulkPut(bundle.blocks);
      await knowledgeDb.entities.bulkPut(bundle.entities);
      await knowledgeDb.relations.bulkPut(bundle.relations);
      await knowledgeDb.canvases.bulkPut(bundle.canvases);
      await knowledgeDb.views.bulkPut(bundle.views);
      await knowledgeDb.trash.bulkPut(bundle.trash);
      await knowledgeDb.snapshots.bulkPut(bundle.snapshots);
      await knowledgeDb.reviewAudit.bulkPut(bundle.reviewAudit);
      await knowledgeDb.queryTraces.bulkPut(bundle.queryTraces);
    })
  ]);
}
