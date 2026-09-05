import { describe, expect, it } from "vitest";
import { validateRelationProofs } from "./engine";
import { reconcileEntityReview, reconcileRelationReview } from "./review";
import { removeCanvasNode } from "./workspace";
import type { UnifiedSourceBlock } from "./hybrid";
import type { RelationPathProof } from "./reasoning";
import type { CanvasRecord, EntityCandidateRecord, RelationCandidateRecord, ReviewStatus } from "./store";

function rng(seed = 0x5eed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const statuses: ReviewStatus[] = ["pending", "accepted", "rejected"];

function entity(index: number, status: ReviewStatus, extractorVersion = "extractor-v1"): EntityCandidateRecord {
  return {
    id: `entity-${index}`,
    canonicalName: `Entity ${index}`,
    normalizedName: `entity ${index}`,
    entityType: "topic",
    evidenceBlockIds: [`block-${index}`],
    confidence: 0.8,
    extractorVersion,
    status,
    aliases: [`Alias ${index}`],
    pinned: index % 2 === 0,
    updatedAt: "2026-09-06T00:00:00.000Z"
  };
}

function relation(index: number, status: ReviewStatus, extractorVersion = "extractor-v1"): RelationCandidateRecord {
  return {
    id: `relation-${index}`,
    sourceEntityId: `entity-${index}`,
    targetEntityId: `entity-${index + 1}`,
    relation: "related-to",
    evidenceBlockIds: [`block-${index}`],
    confidence: 0.8,
    extractorVersion,
    status,
    observedAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z"
  };
}

describe("seeded property invariants", () => {
  it("preserves reviewed entity decisions for the same extractor and reopens changed extractors", () => {
    const random = rng();
    for (let index = 0; index < 250; index += 1) {
      const status = statuses[Math.floor(random() * statuses.length)];
      const previous = entity(index, status);
      const sameVersion = reconcileEntityReview(previous, { ...entity(index, "pending"), aliases: ["Fresh alias"] });
      expect(sameVersion.status).toBe(status);
      expect(sameVersion.pinned).toBe(previous.pinned);
      expect(sameVersion.aliases).toEqual(expect.arrayContaining([previous.aliases[0], "Fresh alias"]));

      const changedVersion = reconcileEntityReview(previous, entity(index, status, "extractor-v2"));
      expect(changedVersion.status).toBe("pending");
      expect(changedVersion.pinned).toBe(previous.pinned);
    }
  });

  it("preserves relation review only while extractor identity is stable", () => {
    const random = rng(73);
    for (let index = 0; index < 250; index += 1) {
      const status = statuses[Math.floor(random() * statuses.length)];
      const previous = { ...relation(index, status), validFrom: "2024-01-01", validTo: "2025-01-01" };
      const stable = reconcileRelationReview(previous, relation(index, "pending"));
      expect(stable.status).toBe(status);
      expect(stable.validFrom).toBe(previous.validFrom);
      expect(stable.validTo).toBe(previous.validTo);
      expect(reconcileRelationReview(previous, relation(index, status, "extractor-v2")).status).toBe("pending");
    }
  });

  it("never validates a sourced path after any required evidence block is removed", () => {
    const random = rng(991);
    for (let iteration = 0; iteration < 120; iteration += 1) {
      const hopCount = 1 + Math.floor(random() * 4);
      const blocks: UnifiedSourceBlock[] = Array.from({ length: hopCount }, (_, index) => ({
        id: `proof-${iteration}-${index}`,
        sourceType: "document",
        sourceId: `doc-${iteration}`,
        title: "Proof",
        headingPath: [],
        text: `Evidence ${index}`
      }));
      const path: RelationPathProof = {
        sourceEntityId: "source",
        targetEntityId: "target",
        hops: blocks.map((block, index) => ({
          relationId: `r-${iteration}-${index}`,
          fromEntityId: `e-${index}`,
          toEntityId: `e-${index + 1}`,
          traversal: "forward",
          relation: "supports",
          evidenceBlockIds: [block.id]
        }))
      };
      expect(validateRelationProofs([path], blocks).valid).toBe(true);
      const missingIndex = Math.floor(random() * blocks.length);
      const remaining = blocks.filter((_, index) => index !== missingIndex);
      const validation = validateRelationProofs([path], remaining);
      expect(validation.valid).toBe(false);
      expect(validation.missingBlockIds).toContain(blocks[missingIndex].id);
    }
  });

  it("canvas node deletion removes every incident edge while preserving unrelated edges", () => {
    const random = rng(2026);
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const nodeCount = 4 + Math.floor(random() * 8);
      const nodes = Array.from({ length: nodeCount }, (_, index) => ({ id: `n-${index}`, kind: "label" as const, label: `N${index}`, x: index * 10, y: index * 5, width: 100, height: 60 }));
      const edges = Array.from({ length: nodeCount * 2 }, (_, index) => {
        const source = Math.floor(random() * nodeCount);
        let target = Math.floor(random() * nodeCount);
        if (target === source) target = (target + 1) % nodeCount;
        return { id: `e-${index}`, source: `n-${source}`, target: `n-${target}` };
      });
      const canvas: CanvasRecord = { id: `c-${iteration}`, title: "Generated", nodes, edges, createdAt: "x", updatedAt: "x" };
      const removed = `n-${Math.floor(random() * nodeCount)}`;
      const next = removeCanvasNode(canvas, removed);
      expect(next.nodes.some((node) => node.id === removed)).toBe(false);
      expect(next.edges.some((edge) => edge.source === removed || edge.target === removed)).toBe(false);
      for (const edge of edges.filter((edge) => edge.source !== removed && edge.target !== removed)) expect(next.edges).toContainEqual(edge);
    }
  });
});
