# EvidenceWeave Workspace Format v0

The browser database is an implementation detail. Portable exports are the user-owned interchange format.

## Workspace

```ts
interface WorkspaceExportV0 {
  schemaVersion: 0;
  exportedAt: string;
  workspace: { id: string; title: string; createdAt: string; updatedAt: string };
  notes: NoteRecord[];
}
```

## Note

Each note has a stable UUID, path, title, Markdown source, timestamps, and optional frontmatter properties derived from the Markdown itself.

## Link syntax supported in the foundation

- `[[Note]]`
- `[[Note|Alias]]`
- `[[Note#Heading]]`

Targets are matched case-insensitively against current note titles. Heading fragments do not change node identity. Unresolved links remain explicit graph edges with `resolved: false` so missing knowledge is inspectable.

## Export invariant

Export followed by import must preserve IDs, Markdown, paths, and timestamps. Later schema versions must provide migrations rather than silently rewriting old exports.
