# EvidenceWeave Graph Studio

**Own your knowledge. Map every connection. Verify every answer.**

EvidenceWeave is a local-first knowledge graph and GraphRAG workspace that runs in your browser. The product is being built from the non-AI core outward: user-owned Markdown, deterministic links/backlinks, an inspectable authored graph, portable exports, and a universal extractive evidence path before optional local generation is added.

> **Current status — Foundation v0.1:** real browser workspace, local persistence, Markdown/TXT import, portable JSON export/restore, typed frontmatter inspection, wiki-link parsing, backlinks, unresolved-link visibility, global authored graph, local search, deterministic evidence retrieval, and offline-PWA scaffolding. Full document ingestion, inferred entities, hybrid vector/graph retrieval, Canvas, local WebLLM generation, and claim/path validation are roadmap items—not shipped claims.

## Product principles

- **Local first:** core note content is stored in IndexedDB in the browser.
- **No required account or API key:** the baseline has no model-provider dependency.
- **Open knowledge:** Markdown remains the source format and the workspace can be exported.
- **Graph before GraphRAG:** authored relationships and graph invariants are established before inferred knowledge is trusted.
- **Evidence before generation:** deterministic evidence search remains the compatibility fallback even after local generation arrives.
- **Visible gaps:** unresolved links and weak retrieval are shown rather than silently invented.
- **Clean-room implementation:** inspired by general knowledge-work patterns, not copied from Obsidian or any other proprietary product.

## What works now

| Capability | Foundation status |
|---|---|
| Local Markdown notes | ✅ IndexedDB persistence |
| Wiki links | ✅ `[[Note]]`, aliases, heading targets |
| Typed properties | ✅ Lightweight YAML frontmatter inspection |
| Tags | ✅ Local parsing and display |
| Backlinks | ✅ Derived from authored links |
| Global graph | ✅ Cytoscape.js, unresolved targets included |
| Full-text note filter | ✅ Local substring search |
| Evidence mode | ✅ Deterministic term scoring + source excerpts |
| Import | ✅ Markdown and TXT |
| Export/restore | ✅ Versioned JSON workspace |
| PWA shell | ✅ Static/offline scaffolding |
| PDF/DOCX/CSV document graph | ⏳ Planned |
| Entity/relationship review queue | ⏳ Planned |
| BM25 + vector + graph RRF | ⏳ Planned |
| GraphRAG answer proof | ⏳ Planned |
| Canvas / database views | ⏳ Planned |
| Local WebLLM | ⏳ Optional later layer |

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
