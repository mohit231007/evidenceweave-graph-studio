# EvidenceWeave Graph Studio

**Own your knowledge. Map every connection. Verify every answer.**

EvidenceWeave is a local-first knowledge graph and GraphRAG workspace that runs in your browser. The product is being built from the non-AI core outward: user-owned Markdown, deterministic links/backlinks, an inspectable authored graph, portable exports, and a universal extractive evidence path before optional local generation is added.

> **Current status — Knowledge Foundation v0.2:** real browser workspace, local persistence, Markdown/TXT import, portable JSON export/restore, typed frontmatter inspection, wiki links, backlinks, unlinked mentions, global/local authored graph exploration, property-library view, deterministic lexical/local/multi-hop query planning, graph-path proof, and offline-PWA scaffolding. Full document ingestion, inferred entity review, vector embeddings, Canvas, local WebLLM generation, and claim-level generated-answer validation are still roadmap items—not shipped claims.

## Product principles

- **Local first:** core note content is stored in IndexedDB in the browser.
- **No required account or API key:** the baseline has no model-provider dependency.
- **Open knowledge:** Markdown remains the source format and the workspace can be exported.
- **Graph before GraphRAG:** authored relationships and graph invariants are established before inferred knowledge is trusted.
- **Evidence before generation:** deterministic evidence search remains the compatibility fallback even after local generation arrives.
- **Visible gaps:** unresolved links, ambiguous titles, weak retrieval, and missing paths are shown rather than silently invented.
- **Explain graph contribution:** graph boosts are accompanied by the exact authored path that produced them.
- **Clean-room implementation:** inspired by general knowledge-work patterns, not copied from Obsidian or any other proprietary product.

## What works now

| Capability | Current status |
|---|---|
| Local Markdown notes | ✅ IndexedDB persistence |
| Safe note rename | ✅ Inbound wiki links rewritten transactionally |
| Wiki links | ✅ `[[Note]]`, aliases, heading targets |
| Typed properties | ✅ Lightweight YAML frontmatter inspection |
| Property library | ✅ Derived table over frontmatter, tags, links, backlinks |
| Tags | ✅ Local parsing and display |
| Backlinks | ✅ Derived from authored links |
| Unlinked mentions | ✅ Plain-text mentions separated from authored links |
| Global graph | ✅ Cytoscape.js, unresolved targets included |
| Local graph | ✅ Selected-note neighborhood with depth 1–3 |
| Full-text note filter | ✅ Local substring search |
| Evidence mode | ✅ Deterministic source excerpts with support threshold |
| Query routing | ✅ Lexical / local-graph / multi-hop authored-path modes |
| Graph proof | ✅ Bounded shortest paths over resolved authored edges |
| Import | ✅ Markdown and TXT with size bounds |
| Export/restore | ✅ Versioned validated JSON workspace |
| PWA shell | ✅ Static/offline scaffolding |
| PDF/DOCX/CSV document graph | ⏳ Planned |
| Entity/relationship review queue | ⏳ Planned |
| BM25 + vector + graph RRF | ⏳ Planned |
| Generated GraphRAG answer synthesis | ⏳ Planned after retrieval/provenance gates |
| Canvas | ⏳ Planned |
| Local WebLLM | ⏳ Optional later layer |

## How graph proof works today

EvidenceWeave does **not** label deterministic retrieval as generated GraphRAG. The current query planner:

1. Finds note titles explicitly named in the question.
2. Routes two-or-more named notes to **multi-hop** mode.
3. Otherwise uses the current note as a **local-graph** anchor when available.
4. Falls back to **lexical** evidence retrieval when no graph anchor exists.
5. Searches source notes with a fail-closed lexical support threshold.
6. Computes bounded shortest paths only over resolved, authored edges.
7. Applies a small graph-path ranking contribution and displays the exact path beside the evidence.
8. Refuses to treat a graph path by itself as proof of a factual claim when no source note crosses the evidence threshold.

This creates the proof layer that later BM25/vector/community retrieval and optional local generation must obey rather than bypass.

## Run locally

Prerequisites: Node.js 22+ and pnpm 10+.

```bash
pnpm install
pnpm dev
```

Verification:

```bash
pnpm check
```

The check runs TypeScript validation, unit tests, and the production Vite build.

## Repository direction

The target architecture is a browser-first TypeScript PWA with optional Tauri desktop distribution. Planned packages separate workspace format, Markdown parsing, graph operations, importers, retrieval, local ML, citation/path validation, and UI concerns as those boundaries become necessary. The foundation intentionally starts with fewer packages to avoid a premature monorepo abstraction before stable APIs exist.

See:

- [`docs/architecture/overview.md`](docs/architecture/overview.md)
- [`docs/workspace-format.md`](docs/workspace-format.md)
- [`docs/privacy.md`](docs/privacy.md)
- [`docs/decisions/0001-local-first-browser-baseline.md`](docs/decisions/0001-local-first-browser-baseline.md)
- [`SECURITY.md`](SECURITY.md)

## Privacy boundary

The current foundation has no application-server upload, analytics SDK, login, or model API. Clearing browser site data can delete the local workspace, so exports are the backup mechanism at this stage. Do not treat the development build as a certified confidential-document environment.

## Obsidian non-affiliation / clean-room statement

EvidenceWeave is inspired by broadly used local-knowledge and graph-workspace patterns. It is **not affiliated with Obsidian** and does not copy Obsidian source code, proprietary assets, branding, CSS, screenshots, plugin APIs, or proprietary interface implementation.

## Cost statement

The intended public baseline is free to use with no required account or API key. Core search, graph navigation, and extractive evidence run on the user's device. Static hosting and CI can use free tiers, so capacity is bounded and provider terms may change. Optional custom domains, desktop signing, or future hosted services may introduce cost.

## License

MIT © 2026 Mohit Bhatnagar. The initial repository was created under MIT and this implementation preserves that owner-selected license.
