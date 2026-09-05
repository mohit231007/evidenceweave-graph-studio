import { describe, expect, it } from "vitest";
import { buildAuthoredGraph, type NoteRecord } from "./core";
import { bm25Rank, noteBlocks } from "./hybrid";

function syntheticNotes(count: number): NoteRecord[] {
  const stamp = "2026-09-06T00:00:00.000Z";
  return Array.from({ length: count }, (_, index) => {
    const title = `Synthetic ${index}`;
    const next = index + 1 < count ? `\nConnects to [[Synthetic ${index + 1}]].` : "";
    return { id: `synthetic-${index}`, title, path: `synthetic-${index}.md`, markdown: `---\nindex: ${index}\n---\n# ${title}\n\nThis is deterministic benchmark note token-${index}.${next}`, createdAt: stamp, updatedAt: stamp };
  });
}

describe("5k-note baseline", () => {
  it("builds graph, source blocks and retrieves a tail note without pathological slowdown", { timeout: 15_000 }, () => {
    const started = performance.now();
    const notes = syntheticNotes(5_000);
    const graph = buildAuthoredGraph(notes);
    const blocks = noteBlocks(notes);
    const hits = bm25Rank("token 4999 Synthetic 4999", blocks, 5);
    const elapsedMs = performance.now() - started;
    expect(graph.nodes).toHaveLength(5_000);
    expect(graph.edges.filter((edge) => edge.resolved)).toHaveLength(4_999);
    expect(blocks.length).toBeGreaterThanOrEqual(5_000);
    expect(hits[0]?.block.sourceId).toBe("synthetic-4999");
    expect(elapsedMs).toBeLessThan(12_000);
  });
});
