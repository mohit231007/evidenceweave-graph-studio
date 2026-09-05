import { describe, expect, it } from "vitest";
import { buildRelationProofs, connectedComponents, findAcceptedRelationPath, parseTemporalConstraint, routeQuery, type TemporalConstraint } from "./reasoning";
import { embeddingRecordId, isEmbeddingFresh, semanticInput } from "./semantic";
import { reconcileEntityReview, reconcileRelationReview } from "./review";
import type { EmbeddingProvider, UnifiedSourceBlock } from "./hybrid";
import type { EmbeddingRecord, EntityCandidateRecord, RelationCandidateRecord } from "./store";

const stamp = "2026-09-06T00:00:00.000Z";
const entity = (id: string, name: string): EntityCandidateRecord => ({ id, canonicalName: name, normalizedName: name.toLowerCase(), entityType: "topic", evidenceBlockIds: [`b-${id}`], confidence: .9, extractorVersion: "e2", status: "accepted", aliases: [], updatedAt: stamp });
const relation = (id: string, source: string, target: string, name: string, overrides: Partial<RelationCandidateRecord> = {}): RelationCandidateRecord => ({ id, sourceEntityId: source, targetEntityId: target, relation: name, evidenceBlockIds: [`b-${id}`], confidence: .9, extractorVersion: "r2", status: "accepted", observedAt: stamp, updatedAt: stamp, ...overrides });

const entities = [entity("a", "Project Atlas"), entity("b", "OpenAI"), entity("c", "Microsoft"), entity("d", "Independent")];
const relations = [relation("r1", "a", "b", "uses"), relation("r2", "b", "c", "partnered-with", { validFrom: "2019-01-01" })];

describe("query routing and proof", () => {
  it("parses temporal ranges", () => {
    expect(parseTemporalConstraint("What changed between 2021 and 2024?")).toMatchObject({ fromYear: 2021, toYear: 2024 });
    expect(parseTemporalConstraint("Who was involved before 2020?")).toMatchObject({ toYear: 2019 });
    expect(parseTemporalConstraint("Changes since 2023")).toMatchObject({ fromYear: 2023 });
  });

  it("routes named reviewed entities to multi-hop", () => {
    expect(routeQuery("How does Project Atlas relate to Microsoft?", entities).mode).toBe("multi-hop");
    expect(routeQuery("What is OpenAI doing?", entities).mode).toBe("local");
    expect(routeQuery("Find \"exact wording\"", entities).mode).toBe("exact");
  });

  it("returns every accepted hop with evidence", () => {
    const proof = findAcceptedRelationPath("a", "c", relations);
    expect(proof?.hops.map((hop) => hop.relation)).toEqual(["uses", "partnered-with"]);
    expect(proof?.hops.every((hop) => hop.evidenceBlockIds.length > 0)).toBe(true);
  });

  it("filters relation paths by valid time", () => {
    const before2018: TemporalConstraint = { toYear: 2018, reason: "test" };
    expect(findAcceptedRelationPath("a", "c", relations, 4, before2018)).toBeUndefined();
  });

  it("builds deterministic accepted connected components", () => {
    const components = connectedComponents(entities, relations);
    expect(components[0]).toEqual(["a", "b", "c"]);
    expect(components[1]).toEqual(["d"]);
    const proof = buildRelationProofs("How does Project Atlas relate to Microsoft?", entities, relations);
    expect(proof.paths).toHaveLength(1);
  });
});

describe("review reconciliation", () => {
  it("preserves a decision only for the same extractor version", () => {
    const previous = { ...entity("x", "X"), status: "rejected" as const, extractorVersion: "e1" };
    const same = { ...previous, status: "pending" as const };
    expect(reconcileEntityReview(previous, same).status).toBe("rejected");
    expect(reconcileEntityReview(previous, { ...same, extractorVersion: "e2" }).status).toBe("pending");
  });

  it("reopens relations after extractor changes", () => {
    const previous = { ...relation("x", "a", "b", "uses"), status: "accepted" as const, extractorVersion: "r1" };
    expect(reconcileRelationReview(previous, { ...previous, status: "pending", extractorVersion: "r2" }).status).toBe("pending");
  });
});

describe("semantic index contracts", () => {
  const block: UnifiedSourceBlock = { id: "b", sourceType: "document", sourceId: "d", title: "Doc", headingPath: ["Section"], text: "Local evidence" };
  const provider: EmbeddingProvider = { id: "model", version: "v1", async embed(texts) { return texts.map(() => [1, 0]); } };
  const record: EmbeddingRecord = { id: "model::b", blockId: "b", modelId: "model", modelVersion: "v1", contentHash: "hash", dimensions: 2, vector: [1, 0], createdAt: stamp };

  it("uses stable model/block IDs and complete semantic input", () => {
    expect(embeddingRecordId(provider, block.id)).toBe("model::b");
    expect(semanticInput(block)).toContain("Section");
  });

  it("invalidates cache when model version or content changes", () => {
    expect(isEmbeddingFresh(record, provider, "hash")).toBe(true);
    expect(isEmbeddingFresh(record, { ...provider, version: "v2" }, "hash")).toBe(false);
    expect(isEmbeddingFresh(record, provider, "other")).toBe(false);
  });
});
