import { describe, expect, it } from "vitest";
import { buildDocumentContainment, ingestBytes, MAX_CSV_CELL_CHARS } from "./documents";
import { blockMatchesTemporal } from "./engine";
import { bm25IndexFor, bm25RankFromIndex, communityGraphRank, graphCommunities, type UnifiedSourceBlock } from "./hybrid";
import type { EntityCandidateRecord, RelationCandidateRecord } from "./store";

const blocks: UnifiedSourceBlock[] = [
  { id: "b-2018", sourceType: "document", sourceId: "d", title: "Acquisition", headingPath: [], text: "Microsoft acquired GitHub in 2018.", mentionedYears: [2018] },
  { id: "b-2024", sourceType: "note", sourceId: "n", title: "Roadmap", headingPath: [], text: "EvidenceWeave v1 roadmap for 2024 migration notes.", mentionedYears: [2024], createdAt: "2024-06-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" },
  { id: "b-noise", sourceType: "document", sourceId: "x", title: "Noise", headingPath: [], text: "bananas bicycles oranges", mentionedYears: [] }
];

const entity = (id: string, name: string, evidenceBlockIds: string[]): EntityCandidateRecord => ({
  id, canonicalName: name, normalizedName: name.toLocaleLowerCase(), entityType: "organization", evidenceBlockIds,
  confidence: 0.9, extractorVersion: "test", status: "accepted", aliases: [], updatedAt: "2026-01-01T00:00:00.000Z"
});
const relation = (id: string, source: string, target: string, evidenceBlockIds: string[]): RelationCandidateRecord => ({
  id, sourceEntityId: source, targetEntityId: target, relation: "acquired", evidenceBlockIds, confidence: 0.9,
  extractorVersion: "test", status: "accepted", observedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
});

describe("completion hardening", () => {
  it("builds and reuses an inverted BM25 index", () => {
    const first = bm25IndexFor(blocks);
    const second = bm25IndexFor(blocks);
    expect(second).toBe(first);
    expect(first.postings.get("microsoft")?.[0]).toMatchObject({ blockIndex: 0, termFrequency: 1 });
    expect(bm25RankFromIndex("microsoft github", first)[0].block.id).toBe("b-2018");
  });

  it("filters source blocks by mentioned and metadata time", () => {
    expect(blockMatchesTemporal(blocks[0], { toYear: 2020 })).toBe(true);
    expect(blockMatchesTemporal(blocks[1], { toYear: 2020 })).toBe(false);
    expect(blockMatchesTemporal(blocks[1], { fromYear: 2024, toYear: 2024 })).toBe(true);
  });

  it("retrieves source-bearing reviewed graph communities without a named anchor", () => {
    const entities = [entity("m", "Microsoft", ["b-2018"]), entity("g", "GitHub", ["b-2018"])];
    const relations = [relation("r", "m", "g", ["b-2018"])];
    expect(graphCommunities(entities, relations)).toEqual([["g", "m"]]);
    expect(communityGraphRank("summarize the overall knowledge", blocks, entities, relations)[0].block.id).toBe("b-2018");
  });

  it("creates a deterministic document containment graph", async () => {
    const csv = new TextEncoder().encode("id,name\n1,Ada\n2,Grace").buffer;
    const bundle = await ingestBytes("people.csv", "text/csv", csv);
    const graph = buildDocumentContainment(bundle.document, bundle.blocks);
    expect(graph.nodes.some((node) => node.kind === "document")).toBe(true);
    expect(graph.nodes.filter((node) => node.kind === "section")).toHaveLength(1);
    expect(graph.nodes.filter((node) => node.kind === "block")).toHaveLength(2);
    expect(graph.edges.every((edge) => edge.relation === "contains")).toBe(true);
  });

  it("fails malformed CSV safely before producing a partial bundle", async () => {
    const malformed = new TextEncoder().encode('id,name\n1,"Ada').buffer;
    await expect(ingestBytes("bad.csv", "text/csv", malformed)).rejects.toThrow(/unterminated quoted field/i);
  });

  it("enforces CSV cell memory bounds", async () => {
    const huge = `id,value\n1,${"x".repeat(MAX_CSV_CELL_CHARS + 1)}`;
    await expect(ingestBytes("huge.csv", "text/csv", new TextEncoder().encode(huge).buffer)).rejects.toThrow(/cell exceeds/i);
  });

  it("honors a pre-aborted import signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(ingestBytes("a.txt", "text/plain", new TextEncoder().encode("hello").buffer, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});
