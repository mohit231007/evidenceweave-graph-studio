import { describe, expect, it } from "vitest";
import { type NoteRecord } from "./core";
import { buildNoteBlocks, buildWorkspaceBlocks, searchEvidenceBlocks, tokenizeRetrieval } from "./retrieval";

const note: NoteRecord = {
  id: "n1",
  path: "Project.md",
  title: "Project",
  createdAt: "x",
  updatedAt: "x",
  markdown: `---\ntype: project\n---\n# Project\n\nThe first paragraph explains baseline assumptions and customer context.\n\n## Outcome\n\nRevenue increased by 12 percent after the experiment, with provenance retained for every claim.\n\nA second paragraph under Outcome records validation details and source ownership.`
};

describe("block provenance", () => {
  it("creates deterministic source blocks with exact offsets and heading context", () => {
    const blocks = buildNoteBlocks(note, 180, 20);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks) {
      expect(note.markdown.slice(block.startOffset, block.endOffset)).toBe(block.text);
      expect(block.id).toBe(`${note.id}::${block.startOffset}-${block.endOffset}`);
    }
    const outcome = blocks.find((block) => block.text.includes("Revenue increased"));
    expect(outcome?.headingPath).toEqual(["Project", "Outcome"]);
  });

  it("rejects unsafe overlap configuration", () => {
    expect(() => buildNoteBlocks(note, 150, 150)).toThrow(/overlap/i);
  });

  it("builds blocks across a workspace", () => {
    const other = { ...note, id: "n2", title: "Other", path: "Other.md", markdown: "# Other\n\nIndependent evidence." };
    expect(buildWorkspaceBlocks([note, other]).some((block) => block.noteId === "n2")).toBe(true);
  });
});

describe("weighted lexical block retrieval", () => {
  it("removes common query words", () => {
    expect(tokenizeRetrieval("What does the Project say about revenue and provenance?")).toEqual(["project", "revenue", "provenance"]);
  });

  it("returns source-block offsets and heading path for supported evidence", () => {
    const hits = searchEvidenceBlocks("What revenue outcome and provenance are recorded?", [note]);
    expect(hits[0].text).toContain("Revenue increased");
    expect(hits[0].headingPath).toEqual(["Project", "Outcome"]);
    expect(hits[0].matchedTerms).toEqual(expect.arrayContaining(["revenue", "outcome", "provenance"]));
    expect(hits[0].score).toBeLessThanOrEqual(1);
  });

  it("allows a rare specific term to retrieve evidence without accepting unrelated noise", () => {
    const other = { ...note, id: "n2", title: "Operations", path: "Operations.md", markdown: "# Operations\n\nRoutine weekly process notes with staffing details." };
    const provenance = searchEvidenceBlocks("provenance", [note, other]);
    expect(provenance[0].noteId).toBe("n1");
    expect(searchEvidenceBlocks("unicorn quantum volcano", [note, other])).toEqual([]);
  });
});
