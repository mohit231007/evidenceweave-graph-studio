import { describe, expect, it } from "vitest";
import { buildAuthoredGraph, type NoteRecord } from "./core";
import {
  planGraphEvidence,
  propertyColumns,
  resolvedSubgraph,
  shortestResolvedPath,
  unlinkedMentionsFor
} from "./knowledge";

const notes: NoteRecord[] = [
  { id: "a", path: "Alpha.md", title: "Alpha", markdown: "---\ntype: project\nstatus: active\n---\n# Alpha\nAlpha connects to [[Bridge]].", createdAt: "x", updatedAt: "x" },
  { id: "b", path: "Bridge.md", title: "Bridge", markdown: "---\ntype: concept\n---\n# Bridge\nBridge connects [[Alpha]] and [[Gamma]].", createdAt: "x", updatedAt: "x" },
  { id: "c", path: "Gamma.md", title: "Gamma", markdown: "# Gamma\nGamma records the measurable outcome and provenance.", createdAt: "x", updatedAt: "x" },
  { id: "d", path: "Loose.md", title: "Loose", markdown: "# Loose\nThe Alpha project is discussed here without a wiki link.", createdAt: "x", updatedAt: "x" }
];

const graph = buildAuthoredGraph(notes);

describe("knowledge maintenance", () => {
  it("finds unlinked mentions but excludes authored wiki links", () => {
    const mentions = unlinkedMentionsFor(notes[0], notes);
    expect(mentions.map((hit) => hit.sourceNoteId)).toEqual(["d"]);
    expect(mentions[0].excerpt).toContain("Alpha project");
  });

  it("orders property columns by workspace prevalence", () => {
    expect(propertyColumns(notes)).toEqual(["type", "status"]);
  });
});

describe("graph proof", () => {
  it("finds a bounded shortest path over resolved authored edges", () => {
    const path = shortestResolvedPath(graph, notes, "a", "c");
    expect(path?.nodeIds).toEqual(["a", "b", "c"]);
    expect(path?.titles).toEqual(["Alpha", "Bridge", "Gamma"]);
    expect(path?.hops).toBe(2);
  });

  it("returns no path through unresolved knowledge", () => {
    expect(shortestResolvedPath(graph, notes, "a", "unresolved:missing")).toBeUndefined();
  });

  it("builds a resolved local subgraph only", () => {
    const subset = resolvedSubgraph(graph, new Set(["a", "b"]));
    expect(subset.nodes.map((node) => node.id).sort()).toEqual(["a", "b"]);
    expect(subset.edges.every((edge) => edge.resolved)).toBe(true);
  });

  it("routes a two-title question to multi-hop proof", () => {
    const trace = planGraphEvidence("How are Alpha and Gamma connected, and what outcome is recorded?", notes, graph);
    expect(trace.mode).toBe("multi-hop");
    expect(trace.anchors.map((anchor) => anchor.id)).toEqual(["a", "c"]);
    expect(trace.paths[0].titles).toEqual(["Alpha", "Bridge", "Gamma"]);
    expect(trace.evidence.some((hit) => hit.noteId === "c")).toBe(true);
  });

  it("uses the selected note as a local graph anchor when titles are absent", () => {
    const trace = planGraphEvidence("What does the workspace say about measurable outcome provenance?", notes, graph, "b");
    expect(trace.mode).toBe("local-graph");
    expect(trace.anchors[0].id).toBe("b");
    expect(trace.evidence[0].noteId).toBe("c");
    expect(trace.evidence[0].graphPath?.titles).toEqual(["Bridge", "Gamma"]);
  });
});
