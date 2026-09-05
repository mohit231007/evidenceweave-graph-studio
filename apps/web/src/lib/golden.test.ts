import { describe, expect, it } from "vitest";
import { bm25Rank } from "./hybrid";
import { runEvidenceQuery } from "./engine";
import { evaluateRetrieval } from "./eval";
import { goldenBlocks, goldenEntities, goldenQuestions, goldenRelations } from "./golden";

describe("golden retrieval corpus", () => {
  it("keeps lexical retrieval strong on direct evidence", () => {
    const cases = goldenQuestions.filter((question) => question.relevantBlockIds.length).map((question) => ({
      id: question.id,
      relevantIds: question.relevantBlockIds,
      rankedIds: bm25Rank(question.question, goldenBlocks, 5).map((hit) => hit.block.id)
    }));
    const metrics = evaluateRetrieval(cases, 5);
    expect(metrics.recallAtK).toBeGreaterThanOrEqual(.75);
    expect(metrics.mrr).toBeGreaterThanOrEqual(.7);
  });

  it("retrieves every sourced hop for the multi-hop golden question", async () => {
    const result = await runEvidenceQuery({ question: "How does Project Atlas relate to Microsoft?", blocks: goldenBlocks, entities: goldenEntities, relations: goldenRelations, limit: 5, persistTrace: false });
    const ids = new Set(result.evidence.map((hit) => hit.block.id));
    expect(ids.has("g-atlas-openai")).toBe(true);
    expect(ids.has("g-openai-microsoft")).toBe(true);
    expect(result.trace.route.mode).toBe("multi-hop");
    expect(result.trace.paths[0]?.hops).toHaveLength(2);
  });

  it("does not invent a graph path for a disconnected question", async () => {
    const result = await runEvidenceQuery({ question: "How does Project Atlas relate to an unknown company?", blocks: goldenBlocks, entities: goldenEntities, relations: goldenRelations, persistTrace: false });
    expect(result.trace.paths).toHaveLength(0);
  });
});
