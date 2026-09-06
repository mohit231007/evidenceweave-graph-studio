import { describe, expect, it } from "vitest";
import { validateRelationProofs } from "./engine";
import { validatePortableWorkspace } from "./portable";
import { reconcileMergedRelation } from "./review";
import { addCanvasEdge, assignCanvasGroup, createSavedView, groupNotesForView, importCanvas, removeCanvasNode } from "./workspace";
import type { NoteRecord } from "./core";
import type { RelationPathProof } from "./reasoning";
import type { CanvasRecord, RelationCandidateRecord } from "./store";

const note = (id: string, title: string, status: string): NoteRecord => ({ id, title, path: `${title}.md`, markdown: `---\nstatus: ${status}\n---\n# ${title}`, createdAt: "2026-01-01", updatedAt: "2026-01-01" });
const relation = (patch: Partial<RelationCandidateRecord> = {}): RelationCandidateRecord => ({
  id: "a::uses::b",
  sourceEntityId: "a",
  targetEntityId: "b",
  relation: "uses",
  evidenceBlockIds: ["e1"],
  confidence: 0.8,
  extractorVersion: "deterministic-relation-v2",
  status: "accepted",
  observedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...patch
});

describe("proof validation", () => {
  it("fails closed when a hop references a missing source block", () => {
    const paths: RelationPathProof[] = [{ sourceEntityId: "a", targetEntityId: "b", hops: [{ relationId: "r", fromEntityId: "a", toEntityId: "b", traversal: "forward", relation: "uses", evidenceBlockIds: ["missing"] }] }];
    expect(validateRelationProofs(paths, []).valid).toBe(false);
    expect(validateRelationProofs(paths, []).missingBlockIds).toEqual(["missing"]);
  });
});

describe("portable v3", () => {
  it("upgrades a v1 bundle, initializes v3 state, and deliberately rebuilds vectors", () => {
    const bundle = validatePortableWorkspace({ schemaVersion: 1, exportedAt: "x", notes: [], documents: [], blocks: [], entities: [], relations: [], canvases: [], views: [], trash: [], snapshots: [] });
    expect(bundle.schemaVersion).toBe(3);
    expect(bundle.embeddingPolicy).toBe("rebuild-on-device");
    expect(bundle.reviewAudit).toEqual([]);
    expect(bundle.queryTraces).toEqual([]);
    expect(bundle.templates).toEqual([]);
    expect(bundle.workspaceState).toEqual([]);
    expect(bundle.migrations).toEqual([]);
    expect(bundle.semanticSuggestions).toEqual([]);
  });

  it("accepts portable v2 and initializes only new v3 collections", () => {
    const bundle = validatePortableWorkspace({ schemaVersion: 2, exportedAt: "x", embeddingPolicy: "rebuild-on-device", notes: [], documents: [], blocks: [], entities: [], relations: [], canvases: [], views: [], trash: [], snapshots: [], reviewAudit: [], queryTraces: [] });
    expect(bundle.schemaVersion).toBe(3);
    expect(bundle.templates).toEqual([]);
    expect(bundle.semanticSuggestions).toEqual([]);
  });

  it("rejects orphan inferred relations", () => {
    expect(() => validatePortableWorkspace({ schemaVersion: 2, exportedAt: "x", embeddingPolicy: "rebuild-on-device", notes: [], documents: [], blocks: [], entities: [], relations: [{ id: "r", sourceEntityId: "a", targetEntityId: "b", relation: "uses", evidenceBlockIds: ["b"], confidence: 1, extractorVersion: "r", status: "accepted", observedAt: "x", updatedAt: "x" }], canvases: [], views: [], trash: [], snapshots: [], reviewAudit: [], queryTraces: [] })).toThrow(/Orphan inferred relation/);
  });
});

describe("workspace parity contracts", () => {
  const canvas: CanvasRecord = { id: "c", title: "Canvas", createdAt: "x", updatedAt: "x", nodes: [{ id: "a", kind: "label", label: "A", x: 10, y: 10, width: 100, height: 60 }, { id: "b", kind: "label", label: "B", x: 200, y: 100, width: 100, height: 60 }], edges: [] };

  it("removes dangling canvas edges with deleted nodes", () => {
    const linked = addCanvasEdge(canvas, "a", "b", "supports");
    expect(linked.edges).toHaveLength(1);
    expect(removeCanvasNode(linked, "a").edges).toHaveLength(0);
  });

  it("creates exportable groups", () => {
    const grouped = assignCanvasGroup(canvas, ["a", "b"], "Cluster");
    expect(grouped.nodes.filter((node) => node.groupId).length).toBe(2);
    expect(grouped.nodes.some((node) => node.kind === "group")).toBe(true);
  });

  it("rejects dangling imported canvas edges", () => {
    const malformed = JSON.stringify({ format: "evidenceweave-canvas-v2", canvas: { ...canvas, edges: [{ id: "e", source: "a", target: "missing" }] } });
    expect(() => importCanvas(malformed)).toThrow(/dangling edge/);
  });

  it("groups property views deterministically", () => {
    const view = { ...createSavedView("Board", "kanban", "status"), filters: [] };
    const groups = groupNotesForView([note("1", "One", "todo"), note("2", "Two", "done"), note("3", "Three", "todo")], view);
    expect([...groups.keys()]).toEqual(["done", "todo"]);
    expect(groups.get("todo")).toHaveLength(2);
  });
});

describe("entity merge relation safety", () => {
  it("unions provenance and reopens a collided relation when review states disagree", () => {
    const merged = reconcileMergedRelation(
      relation({ evidenceBlockIds: ["e1"], status: "accepted", confidence: 0.8, validFrom: "2020-01-01" }),
      relation({ evidenceBlockIds: ["e2"], status: "rejected", confidence: 0.95, validFrom: "2021-01-01", extractorVersion: "model-v1" })
    );
    expect(merged.evidenceBlockIds.sort()).toEqual(["e1", "e2"]);
    expect(merged.confidence).toBe(0.95);
    expect(merged.status).toBe("pending");
    expect(merged.validFrom).toBeUndefined();
    expect(merged.extractorVersion).toBe("merge-reconciled-v1");
  });

  it("preserves accepted review state when both collided relations were accepted", () => {
    const merged = reconcileMergedRelation(relation({ evidenceBlockIds: ["e1"] }), relation({ evidenceBlockIds: ["e2"] }));
    expect(merged.status).toBe("accepted");
    expect(merged.evidenceBlockIds).toEqual(["e1", "e2"]);
  });
});
