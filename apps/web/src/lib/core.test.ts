import { describe, expect, it } from "vitest";
import { buildAuthoredGraph, extractiveEvidenceSearch, localNeighborhood, parseMarkdown, type NoteRecord } from "./core";

const notes: NoteRecord[] = [
  { id: "a", path: "Alpha.md", title: "Alpha", markdown: "---\npriority: 2\nactive: true\n---\nAlpha links [[Beta|the beta note]]. #one", createdAt: "x", updatedAt: "x" },
  { id: "b", path: "Beta.md", title: "Beta", markdown: "Beta discusses provenance and citations. [[Missing]] #two", createdAt: "x", updatedAt: "x" }
];

describe("markdown parsing", () => {
  it("extracts typed properties, links and tags", () => {
    const parsed = parseMarkdown(notes[0].markdown);
    expect(parsed.properties).toEqual({ priority: 2, active: true });
    expect(parsed.links[0]).toMatchObject({ target: "Beta", alias: "the beta note" });
    expect(parsed.tags).toEqual(["one"]);
  });
});

describe("authored graph", () => {
  it("keeps unresolved links visible instead of inventing nodes", () => {
    const graph = buildAuthoredGraph(notes);
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges.find((edge) => edge.source === "a")?.target).toBe("b");
    expect(graph.nodes.find((node) => node.id === "unresolved:missing")?.kind).toBe("unresolved");
  });
  it("returns deterministic local neighborhoods", () => {
    const graph = buildAuthoredGraph(notes);
    expect([...localNeighborhood("a", graph, 1)].sort()).toEqual(["a", "b"]);
    expect(localNeighborhood("a", graph, 2).has("unresolved:missing")).toBe(true);
  });
});

describe("extractive evidence", () => {
  it("ranks matching source notes and returns proof excerpts", () => {
    const graph = buildAuthoredGraph(notes);
    const hits = extractiveEvidenceSearch("Where are provenance citations discussed?", notes, graph);
    expect(hits[0].noteId).toBe("b");
    expect(hits[0].excerpt.toLowerCase()).toContain("provenance");
  });
});
