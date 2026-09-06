import { describe, expect, it } from "vitest";
import { bm25Rank, graphRank, reciprocalRankFusion } from "./hybrid";
import { runEvidenceQuery } from "./engine";
import { evaluateRetrieval, pathRecall } from "./eval";
import { verifyExtractive } from "./verify";
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
    expect(metrics.ndcgAtK).toBeGreaterThanOrEqual(.7);
  });

  it("keeps deterministic BM25+graph RRF at least as strong as the best enabled single channel on the golden corpus", () => {
    const questions = goldenQuestions.filter((question) => question.relevantBlockIds.length);
    const lexicalCases = questions.map((question) => ({ id: question.id, relevantIds: question.relevantBlockIds, rankedIds: bm25Rank(question.question, goldenBlocks, 5).map((hit) => hit.block.id) }));
    const graphCases = questions.map((question) => ({ id: question.id, relevantIds: question.relevantBlockIds, rankedIds: graphRank(question.question, goldenBlocks, goldenEntities, goldenRelations, 5).map((hit) => hit.block.id) }));
    const fusedCases = questions.map((question) => ({
      id: question.id,
      relevantIds: question.relevantBlockIds,
      rankedIds: reciprocalRankFusion({
        bm25: bm25Rank(question.question, goldenBlocks, 10),
        graph: graphRank(question.question, goldenBlocks, goldenEntities, goldenRelations, 10)
      }, 5).map((hit) => hit.block.id)
    }));
    const lexical = evaluateRetrieval(lexicalCases, 5);
    const graph = evaluateRetrieval(graphCases, 5);
    const fused = evaluateRetrieval(fusedCases, 5);
    expect(fused.recallAtK).toBeGreaterThanOrEqual(Math.max(lexical.recallAtK, graph.recallAtK));
    expect(fused.mrr).toBeGreaterThanOrEqual(Math.max(lexical.mrr, graph.mrr));
    expect(fused.ndcgAtK).toBeGreaterThanOrEqual(Math.max(lexical.ndcgAtK, graph.ndcgAtK));
  });

  it("retrieves every sourced hop for the multi-hop golden question", async () => {
    const result = await runEvidenceQuery({ question: "How does Project Atlas relate to Microsoft?", blocks: goldenBlocks, entities: goldenEntities, relations: goldenRelations, limit: 5, persistTrace: false });
    const ids = new Set(result.evidence.map((hit) => hit.block.id));
    expect(ids.has("g-atlas-openai")).toBe(true);
    expect(ids.has("g-openai-microsoft")).toBe(true);
    expect(result.trace.route.mode).toBe("multi-hop");
    expect(result.trace.paths[0]?.hops).toHaveLength(2);
    const actualEdges = result.trace.paths.flatMap((path) => path.hops.map((hop) => hop.relationId));
    expect(pathRecall(["r-atlas-openai", "r-openai-microsoft"], actualEdges)).toBe(1);
  });

  it("does not inject community evidence into unrelated non-broad questions", () => {
    expect(graphRank("Where does EvidenceWeave store authored notes?", goldenBlocks, goldenEntities, goldenRelations, 5)).toEqual([]);
  });

  it("refuses a temporally scoped out-of-domain question without fabricated evidence", async () => {
    const result = await runEvidenceQuery({ question: "What was Apple revenue in 2024?", blocks: goldenBlocks, entities: goldenEntities, relations: goldenRelations, persistTrace: false });
    expect(result.evidence).toHaveLength(0);
    expect(result.trace.paths).toHaveLength(0);
    const verified = verifyExtractive("What was Apple revenue in 2024?", result.evidence);
    expect(verified.answer).toMatch(/^Evidence gap:/);
  });

  it("does not invent a graph path for a disconnected question", async () => {
    const result = await runEvidenceQuery({ question: "How does Project Atlas relate to an unknown company?", blocks: goldenBlocks, entities: goldenEntities, relations: goldenRelations, persistTrace: false });
    expect(result.trace.paths).toHaveLength(0);
  });
});
