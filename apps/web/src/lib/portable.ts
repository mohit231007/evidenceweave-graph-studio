import { db, type NoteRecord } from "./core";
import { knowledgeDb, type CanvasRecord, type DocumentBlockRecord, type EntityCandidateRecord, type RelationCandidateRecord, type SavedViewRecord, type SnapshotRecord, type SourceDocumentRecord, type TrashRecord } from "./store";

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

export function validatePortableWorkspace(value: unknown): PortableWorkspaceV1 {
  if (!value || typeof value !== "object") throw new Error("Workspace bundle must be an object.");
  const candidate = value as Partial<PortableWorkspaceV1>;
  if (candidate.schemaVersion !== 1) throw new Error("Unsupported EvidenceWeave workspace schema.");
  for (const key of ["notes", "documents", "blocks", "entities", "relations", "canvases", "views", "trash", "snapshots"] as const) {
    if (!Array.isArray(candidate[key])) throw new Error(`Workspace bundle is missing ${key}.`);
  }
  const ids = new Set<string>();
  for (const note of candidate.notes!) {
    if (!note || typeof note.id !== "string" || typeof note.title !== "string" || typeof note.markdown !== "string") throw new Error("Workspace contains a malformed note.");
    if (ids.has(note.id)) throw new Error(`Duplicate note id: ${note.id}`);
    ids.add(note.id);
  }
  for (const block of candidate.blocks!) {
    if (!candidate.documents!.some((document) => document.id === block.documentId)) throw new Error(`Orphan document block: ${block.id}`);
  }
  return candidate as PortableWorkspaceV1;
}

export async function exportPortableWorkspace(notes: NoteRecord[]): Promise<PortableWorkspaceV1> {
  const [documents, blocks, entities, relations, canvases, views, trash, snapshots] = await Promise.all([
    knowledgeDb.documents.toArray(), knowledgeDb.blocks.toArray(), knowledgeDb.entities.toArray(), knowledgeDb.relations.toArray(),
    knowledgeDb.canvases.toArray(), knowledgeDb.views.toArray(), knowledgeDb.trash.toArray(), knowledgeDb.snapshots.toArray()
  ]);
  return { schemaVersion: 1, exportedAt: new Date().toISOString(), notes, documents, blocks, entities, relations, canvases, views, trash, snapshots };
}

export async function restorePortableWorkspace(bundle: PortableWorkspaceV1): Promise<void> {
  await Promise.all([
    db.transaction("rw", db.notes, async () => { await db.notes.clear(); await db.notes.bulkPut(bundle.notes); }),
    knowledgeDb.transaction("rw", [knowledgeDb.documents, knowledgeDb.blocks, knowledgeDb.entities, knowledgeDb.relations, knowledgeDb.canvases, knowledgeDb.views, knowledgeDb.trash, knowledgeDb.snapshots], async () => {
      await Promise.all([
        knowledgeDb.documents.clear(), knowledgeDb.blocks.clear(), knowledgeDb.entities.clear(), knowledgeDb.relations.clear(), knowledgeDb.canvases.clear(), knowledgeDb.views.clear(), knowledgeDb.trash.clear(), knowledgeDb.snapshots.clear()
      ]);
      await knowledgeDb.documents.bulkPut(bundle.documents);
      await knowledgeDb.blocks.bulkPut(bundle.blocks);
      await knowledgeDb.entities.bulkPut(bundle.entities);
      await knowledgeDb.relations.bulkPut(bundle.relations);
      await knowledgeDb.canvases.bulkPut(bundle.canvases);
      await knowledgeDb.views.bulkPut(bundle.views);
      await knowledgeDb.trash.bulkPut(bundle.trash);
      await knowledgeDb.snapshots.bulkPut(bundle.snapshots);
    })
  ]);
}
