import Dexie, { type Table } from "dexie";

export type DocumentFormat = "markdown" | "text" | "csv" | "html" | "pdf" | "docx";
export type ReviewStatus = "pending" | "accepted" | "rejected";

export interface SourceDocumentRecord {
  id: string;
  name: string;
  format: DocumentFormat;
  mimeType: string;
  size: number;
  sha256: string;
  importedAt: string;
  extractorName: string;
  extractorVersion: string;
  status: "indexed" | "failed";
  error?: string;
}

export interface SourceLocation {
  page?: number;
  row?: number;
  columns?: string[];
  section?: string;
  startOffset?: number;
  endOffset?: number;
}

export interface DocumentBlockRecord {
  id: string;
  documentId: string;
  documentTitle: string;
  format: DocumentFormat;
  headingPath: string[];
  text: string;
  location: SourceLocation;
  contentHash: string;
  extractorVersion: string;
}

export interface EntityCandidateRecord {
  id: string;
  canonicalName: string;
  normalizedName: string;
  entityType: "person" | "organization" | "place" | "product" | "project" | "topic" | "metric" | "date" | "identifier" | "url";
  evidenceBlockIds: string[];
  confidence: number;
  extractorVersion: string;
  status: ReviewStatus;
  aliases: string[];
  updatedAt: string;
}

export interface RelationCandidateRecord {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  relation: string;
  evidenceBlockIds: string[];
  confidence: number;
  extractorVersion: string;
  status: ReviewStatus;
  validFrom?: string;
  validTo?: string;
  observedAt: string;
  updatedAt: string;
}

export interface EmbeddingRecord {
  id: string;
  blockId: string;
  modelId: string;
  modelVersion: string;
  dimensions: number;
  vector: number[];
  createdAt: string;
}

export interface CanvasNodeRecord {
  id: string;
  kind: "note" | "document" | "label";
  refId?: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasEdgeRecord {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface CanvasRecord {
  id: string;
  title: string;
  nodes: CanvasNodeRecord[];
  edges: CanvasEdgeRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface SavedViewRecord {
  id: string;
  title: string;
  mode: "table" | "cards" | "list" | "kanban";
  groupBy?: string;
  filters: { property: string; operator: "equals" | "contains" | "exists"; value?: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface TrashRecord {
  id: string;
  kind: "note" | "document" | "canvas";
  payload: string;
  deletedAt: string;
}

export interface SnapshotRecord {
  id: string;
  label: string;
  payload: string;
  createdAt: string;
}

class EvidenceWeaveKnowledgeDB extends Dexie {
  documents!: Table<SourceDocumentRecord, string>;
  blocks!: Table<DocumentBlockRecord, string>;
  entities!: Table<EntityCandidateRecord, string>;
  relations!: Table<RelationCandidateRecord, string>;
  embeddings!: Table<EmbeddingRecord, string>;
  canvases!: Table<CanvasRecord, string>;
  views!: Table<SavedViewRecord, string>;
  trash!: Table<TrashRecord, string>;
  snapshots!: Table<SnapshotRecord, string>;

  constructor() {
    super("evidenceweave-knowledge");
    this.version(1).stores({
      documents: "id, name, format, sha256, importedAt, status",
      blocks: "id, documentId, format, contentHash",
      entities: "id, normalizedName, entityType, status, updatedAt",
      relations: "id, sourceEntityId, targetEntityId, relation, status, updatedAt",
      embeddings: "id, blockId, modelId, modelVersion, createdAt",
      canvases: "id, title, updatedAt",
      views: "id, title, mode, updatedAt",
      trash: "id, kind, deletedAt",
      snapshots: "id, createdAt"
    });
  }
}

export const knowledgeDb = new EvidenceWeaveKnowledgeDB();
