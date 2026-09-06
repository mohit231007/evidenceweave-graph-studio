import { db, type NoteRecord } from "./core";
import {
  knowledgeDb,
  type CanvasRecord,
  type DocumentBlockRecord,
  type EntityCandidateRecord,
  type MigrationRecord,
  type QueryTraceRecord,
  type RelationCandidateRecord,
  type ReviewAuditRecord,
  type SavedViewRecord,
  type SemanticLinkSuggestionRecord,
  type SnapshotRecord,
  type SourceDocumentRecord,
  type TemplateRecord,
  type TrashRecord,
  type WorkspaceStateRecord
} from "./store";

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

export interface PortableWorkspaceV3 extends Omit<PortableWorkspaceV2, "schemaVersion"> {
  schemaVersion: 3;
  templates: TemplateRecord[];
  workspaceState: WorkspaceStateRecord[];
  migrations: MigrationRecord[];
  semanticSuggestions: SemanticLinkSuggestionRecord[];
}

export type PortableWorkspace = PortableWorkspaceV1 | PortableWorkspaceV2 | PortableWorkspaceV3;
type PortableCandidate = Partial<Omit<PortableWorkspaceV3, "schemaVersion">> & {
  schemaVersion?: number;
  reviewAudit?: ReviewAuditRecord[];
  queryTraces?: QueryTraceRecord[];
  templates?: TemplateRecord[];
  workspaceState?: WorkspaceStateRecord[];
  migrations?: MigrationRecord[];
  semanticSuggestions?: SemanticLinkSuggestionRecord[];
};

const requiredArrays = ["notes", "documents", "blocks", "entities", "relations", "canvases", "views", "trash", "snapshots"] as const;

export function validatePortableWorkspace(value: unknown): PortableWorkspaceV3 {
  if (!value || typeof value !== "object") throw new Error("Workspace bundle must be an object.");
  const candidate = value as PortableCandidate;
  if (![1, 2, 3].includes(candidate.schemaVersion ?? 0)) throw new Error("Unsupported EvidenceWeave workspace schema.");
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
  for (const suggestion of candidate.semanticSuggestions ?? []) {
    if (!entityIds.has(suggestion.sourceEntityId) || !entityIds.has(suggestion.targetEntityId)) throw new Error(`Orphan semantic suggestion: ${suggestion.id}`);
    if (!suggestion.evidenceBlockIds.length) throw new Error(`Semantic suggestion lacks provenance: ${suggestion.id}`);
  }
  return {
    schemaVersion: 3,
    embeddingPolicy: "rebuild-on-device",
    exportedAt: candidate.exportedAt ?? new Date().toISOString(),
    notes: candidate.notes!,
    documents: candidate.documents!,
    blocks: candidate.blocks!,
    entities: candidate.entities!,
    relations: candidate.relations!,
    canvases: candidate.canvases!,
    views: candidate.views!,
    trash: candidate.trash!,
    snapshots: candidate.snapshots!,
    reviewAudit: Array.isArray(candidate.reviewAudit) ? candidate.reviewAudit : [],
    queryTraces: Array.isArray(candidate.queryTraces) ? candidate.queryTraces : [],
    templates: Array.isArray(candidate.templates) ? candidate.templates : [],
    workspaceState: Array.isArray(candidate.workspaceState) ? candidate.workspaceState : [],
    migrations: Array.isArray(candidate.migrations) ? candidate.migrations : [],
    semanticSuggestions: Array.isArray(candidate.semanticSuggestions) ? candidate.semanticSuggestions : []
  };
}

export async function exportPortableWorkspace(notes: NoteRecord[]): Promise<PortableWorkspaceV3> {
  const [documents, blocks, entities, relations, canvases, views, trash, snapshots, reviewAudit, queryTraces, templates, workspaceState, migrations, semanticSuggestions] = await Promise.all([
    knowledgeDb.documents.toArray(),
    knowledgeDb.blocks.toArray(),
    knowledgeDb.entities.toArray(),
    knowledgeDb.relations.toArray(),
    knowledgeDb.canvases.toArray(),
    knowledgeDb.views.toArray(),
    knowledgeDb.trash.toArray(),
    knowledgeDb.snapshots.toArray(),
    knowledgeDb.reviewAudit.toArray(),
    knowledgeDb.queryTraces.toArray(),
    knowledgeDb.templates.toArray(),
    knowledgeDb.workspaceState.toArray(),
    knowledgeDb.migrations.toArray(),
    knowledgeDb.semanticSuggestions.toArray()
  ]);
  return {
    schemaVersion: 3,
    embeddingPolicy: "rebuild-on-device",
    exportedAt: new Date().toISOString(),
    notes,
    documents,
    blocks,
    entities,
    relations,
    canvases,
    views,
    trash,
    snapshots,
    reviewAudit,
    queryTraces,
    templates,
    workspaceState,
    migrations,
    semanticSuggestions
  };
}

export async function restorePortableWorkspace(input: PortableWorkspace): Promise<void> {
  const bundle = validatePortableWorkspace(input);
  await Promise.all([
    db.transaction("rw", db.notes, async () => { await db.notes.clear(); await db.notes.bulkPut(bundle.notes); }),
    knowledgeDb.transaction("rw", [
      knowledgeDb.documents,
      knowledgeDb.blocks,
      knowledgeDb.entities,
      knowledgeDb.relations,
      knowledgeDb.embeddings,
      knowledgeDb.canvases,
      knowledgeDb.views,
      knowledgeDb.templates,
      knowledgeDb.workspaceState,
      knowledgeDb.migrations,
      knowledgeDb.semanticSuggestions,
      knowledgeDb.trash,
      knowledgeDb.snapshots,
      knowledgeDb.reviewAudit,
      knowledgeDb.queryTraces
    ], async () => {
      await Promise.all([
        knowledgeDb.documents.clear(),
        knowledgeDb.blocks.clear(),
        knowledgeDb.entities.clear(),
        knowledgeDb.relations.clear(),
        knowledgeDb.embeddings.clear(),
        knowledgeDb.canvases.clear(),
        knowledgeDb.views.clear(),
        knowledgeDb.templates.clear(),
        knowledgeDb.workspaceState.clear(),
        knowledgeDb.migrations.clear(),
        knowledgeDb.semanticSuggestions.clear(),
        knowledgeDb.trash.clear(),
        knowledgeDb.snapshots.clear(),
        knowledgeDb.reviewAudit.clear(),
        knowledgeDb.queryTraces.clear()
      ]);
      await knowledgeDb.documents.bulkPut(bundle.documents);
      await knowledgeDb.blocks.bulkPut(bundle.blocks);
      await knowledgeDb.entities.bulkPut(bundle.entities);
      await knowledgeDb.relations.bulkPut(bundle.relations);
      await knowledgeDb.canvases.bulkPut(bundle.canvases);
      await knowledgeDb.views.bulkPut(bundle.views);
      await knowledgeDb.templates.bulkPut(bundle.templates);
      await knowledgeDb.workspaceState.bulkPut(bundle.workspaceState);
      await knowledgeDb.migrations.bulkPut(bundle.migrations);
      await knowledgeDb.semanticSuggestions.bulkPut(bundle.semanticSuggestions);
      await knowledgeDb.trash.bulkPut(bundle.trash);
      await knowledgeDb.snapshots.bulkPut(bundle.snapshots);
      await knowledgeDb.reviewAudit.bulkPut(bundle.reviewAudit);
      await knowledgeDb.queryTraces.bulkPut(bundle.queryTraces);
    })
  ]);
}
