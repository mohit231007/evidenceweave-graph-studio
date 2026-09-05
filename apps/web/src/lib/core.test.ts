import { describe, expect, it } from "vitest";
import {
  buildAuthoredGraph,
  extractiveEvidenceSearch,
  localNeighborhood,
  makeUniqueTitle,
  parseMarkdown,
  rewriteWikiLinkTarget,
  validateWorkspaceExport,
  type NoteRecord
} from "./core";

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

describe("note identity and rename safety", () => {
  it("creates deterministic unique titles", () => {
    expect(makeUniqueTitle("Alpha", notes)).toBe("Alpha (2)");
    expect(makeUniqueTitle("Beta", notes, "b")).toBe("Beta");
  });

  it("rewrites exact wiki-link targets while preserving headings and aliases", () => {
    const markdown = "[[Alpha]] [[Alpha#Section]] [[Alpha|alias]] [[Alphabet]] [[alpha]]";
    expect(rewriteWikiLinkTarget(markdown, "Alpha", "Renamed")).toBe(
      "[[Renamed]] [[Renamed#Section]] [[Renamed|alias]] [[Alphabet]] [[Renamed]]"
    );
  });
});

describe("authored graph", () => {
  it("keeps unresolved links visible instead of inventing nodes", () => {
    const graph = buildAuthoredGraph(notes);
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges.find((edge) => edge.source === "a")?.target).toBe("b");
    expect(graph.nodes.find((node) => node.id === "unresolved:missing")?.kind).toBe("unresolved");
  });

  it("does not arbitrarily resolve duplicate titles", () => {
    const duplicates = [
      ...notes,
      { id: "b2", path: "Beta-2.md", title: "Beta", markdown: "Duplicate title.", createdAt: "x", updatedAt: "x" }
    ];
    const graph = buildAuthoredGraph(duplicates);
    const alphaEdge = graph.edges.find((edge) => edge.source === "a");
    expect(alphaEdge).toMatchObject({ target: "unresolved:beta", resolved: false });
    expect(graph.nodes.find((node) => node.id === "unresolved:beta")?.title).toBe("Beta (ambiguous)");
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
    expect(hits[0].score).toBeLessThanOrEqual(1);
  });

  it("fails closed on weak lexical overlap", () => {
    const graph = buildAuthoredGraph(notes);
    expect(extractiveEvidenceSearch("provenance revenue roadmap operations", notes, graph)).toEqual([]);
  });
});

describe("portable workspace validation", () => {
  it("rejects duplicate titles instead of creating ambiguous identity", () => {
    expect(() => validateWorkspaceExport({
      schemaVersion: 0,
      exportedAt: "x",
      workspace: { id: "w", title: "W", createdAt: "x", updatedAt: "x" },
      notes: [notes[0], { ...notes[0], id: "other", path: "Other.md" }]
    })).toThrow(/duplicate or empty note title/i);
  });
});
