import { describe, expect, it } from "vitest";
import { detectFormat, formatLocation, ingestBytes, sha256Hex } from "./documents";
import { extractEntityCandidates, extractRelationCandidates, updateReviewStatus } from "./entities";
import { bm25Rank, cosineSimilarity, reciprocalRankFusion, type UnifiedSourceBlock } from "./hybrid";
import { validateAnswer, verifyExtractive } from "./verify";
import { dailyNoteTitle, expandTemplate, moveCanvasNode } from "./workspace";
import { evaluateRetrieval, pathRecall } from "./eval";

const blocks: UnifiedSourceBlock[] = [
  { id: "b1", sourceType: "document", sourceId: "d1", title: "Project", headingPath: ["Architecture"], text: "EvidenceWeave uses IndexedDB for local storage and GraphRAG for retrieval." },
  { id: "b2", sourceType: "document", sourceId: "d1", title: "Project", headingPath: ["Company"], text: "Microsoft acquired GitHub in 2018." },
  { id: "b3", sourceType: "document", sourceId: "d2", title: "Noise", headingPath: [], text: "Oranges and bicycles are unrelated." }
];

describe("document ingestion", () => {
  it("detects supported formats", () => {
    expect(detectFormat("a.pdf", "")).toBe("pdf");
    expect(detectFormat("a.csv", "text/csv")).toBe("csv");
    expect(detectFormat("a.exe", "")).toBeUndefined();
  });

  it("hashes deterministically", async () => {
    expect(await sha256Hex("abc")).toBe(await sha256Hex("abc"));
    expect(await sha256Hex("abc")).not.toBe(await sha256Hex("abd"));
  });

  it("creates row-level CSV provenance", async () => {
    const csv = new TextEncoder().encode("id,name\n1,Ada\n2,Grace").buffer;
    const bundle = await ingestBytes("people.csv", "text/csv", csv);
    expect(bundle.blocks).toHaveLength(2);
    expect(bundle.blocks[0].location.row).toBe(2);
    expect(bundle.blocks[0].text).toContain("name: Ada");
    expect(formatLocation(bundle.blocks[0].location)).toContain("row 2");
  });
});

describe("inferred knowledge", () => {
  it("extracts deterministic candidates and provenance", () => {
    const entities = extractEntityCandidates(blocks);
    expect(entities.some((entity) => entity.canonicalName.includes("Microsoft"))).toBe(true);
    expect(entities.every((entity) => entity.evidenceBlockIds.length > 0)).toBe(true);
  });

  it("keeps relations pending until reviewed", () => {
    const entities = extractEntityCandidates(blocks);
    const relations = extractRelationCandidates(blocks, entities);
    expect(relations.every((relation) => relation.status === "pending")).toBe(true);
    if (relations[0]) expect(updateReviewStatus(relations[0], "accepted").status).toBe("accepted");
  });
});

describe("hybrid retrieval primitives", () => {
  it("ranks relevant BM25 blocks ahead of noise", () => {
    const ranked = bm25Rank("local IndexedDB storage", blocks);
    expect(ranked[0].block.id).toBe("b1");
  });

  it("computes cosine similarity", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("fuses rank channels deterministically", () => {
    const fused = reciprocalRankFusion({
      bm25: [{ block: blocks[0], score: 1 }, { block: blocks[1], score: 0.5 }],
      graph: [{ block: blocks[1], score: 1 }, { block: blocks[0], score: 0.7 }]
    });
    expect(fused).toHaveLength(2);
    expect(fused[0].fusedScore).toBeGreaterThan(0);
  });
});

describe("answer verification", () => {
  it("creates citation-bearing extractive answers", () => {
    const evidence = reciprocalRankFusion({ bm25: [{ block: blocks[0], score: 1 }] });
    const result = verifyExtractive("What storage does EvidenceWeave use?", evidence);
    expect(result.answer).toContain("[S1]");
    expect(result.coverage).toBeGreaterThan(0);
  });

  it("rejects uncited claims", () => {
    const evidence = reciprocalRankFusion({ bm25: [{ block: blocks[0], score: 1 }] });
    expect(validateAnswer("EvidenceWeave was built by Microsoft.", evidence)[0].supported).toBe(false);
  });
});

describe("workspace utilities", () => {
  it("creates deterministic daily note titles", () => {
    expect(dailyNoteTitle(new Date(2026, 8, 6))).toBe("Daily 2026-09-06");
  });

  it("expands local templates", () => {
    expect(expandTemplate("# {{title}}\n{{date}}", new Date(2026, 8, 6, 9, 5), { title: "Log" })).toContain("# Log\n2026-09-06");
  });

  it("moves canvas nodes without mutating other nodes", () => {
    const canvas = { id: "c", title: "C", createdAt: "x", updatedAt: "x", edges: [], nodes: [{ id: "n", kind: "label" as const, label: "N", x: 1, y: 2, width: 10, height: 10 }] };
    expect(moveCanvasNode(canvas, "n", 20, 30).nodes[0]).toMatchObject({ x: 20, y: 30 });
  });
});

describe("evaluation", () => {
  it("computes standard retrieval metrics", () => {
    const metrics = evaluateRetrieval([{ id: "q", relevantIds: ["a", "b"], rankedIds: ["a", "c", "b"] }], 3);
    expect(metrics.recallAtK).toBe(1);
    expect(metrics.mrr).toBe(1);
    expect(metrics.ndcgAtK).toBeGreaterThan(0.8);
    expect(pathRecall(["a>b", "b>c"], ["a>b"])).toBe(0.5);
  });
});
