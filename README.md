# EvidenceWeave Graph Studio

**Own your knowledge. Map every connection. Verify every answer.**

EvidenceWeave Graph Studio is a local-first knowledge workspace and provenance-first GraphRAG application that runs in the browser. Markdown stays user-owned and authoritative; imported documents, inferred entities, embeddings, graph paths, retrieval traces, and generated answers remain derived layers that can be inspected, reviewed, exported, rebuilt, or rejected.

> **Current status — v1 release candidate:** the browser product now includes local Markdown authoring, document ingestion with source provenance, authored and reviewed-inferred graph layers, human review/audit, BM25 + optional local vector + reviewed graph retrieval fused with Reciprocal Rank Fusion, explicit exact/local/multi-hop/global/temporal routing, sourced relationship-path proof, query traces, evidence-first answer verification, optional local WebLLM generation, Canvas, saved views, daily notes, trash/snapshots, portable workspace v2, PWA support, unit/evaluation/scale tests, Chromium end-to-end tests, and a zero-cost GitHub Pages deployment workflow.

## Product principles

- **Local first.** Notes and derived knowledge are stored in browser IndexedDB. There is no required EvidenceWeave application server.
- **No required account or API key.** Core authoring, graph navigation, BM25 retrieval, evidence verification, review, and workspace management do not require a model-provider account.
- **Markdown is authoritative.** Derived graph/ML state never silently replaces authored Markdown.
- **Inference is reviewable.** Extracted entity and relationship candidates remain pending until a user explicitly accepts them.
- **Evidence before generation.** Retrieval and proof work without an LLM. Optional local generation is downstream of evidence and is post-validated.
- **Provenance is first-class.** Imported blocks retain document identity plus page, row, section, or source-offset information where the source format supports it.
- **Visible gaps.** Missing evidence, unresolved links, missing reviewed paths, malformed imports, and unsupported generated claims are surfaced instead of invented away.
- **Portable by design.** Workspace v2 exports notes, documents, blocks, reviewed knowledge, Canvas data, saved views, recovery data, audit history, and query traces. Embeddings are deliberately rebuilt on-device instead of being treated as canonical data.
- **Clean-room implementation.** EvidenceWeave is inspired by general local-knowledge/workspace patterns; it is not an Obsidian derivative and does not copy Obsidian source, assets, branding, CSS, proprietary APIs, or trade dress.

## What works now

| Capability | v1 status |
|---|---|
| Local Markdown notes | ✅ IndexedDB persistence |
| Safe rename | ✅ Inbound wiki links rewritten transactionally |
| Wiki links / aliases / heading targets | ✅ |
| Tags, typed frontmatter, backlinks | ✅ |
| Daily notes + templates | ✅ |
| Search/filter | ✅ Local note filtering |
| Markdown preview | ✅ Sanitized before DOM insertion |
| Markdown / TXT import | ✅ |
| CSV import | ✅ Row-level provenance |
| PDF import | ✅ Page-level text provenance |
| DOCX import | ✅ Browser-side extraction with section/block provenance |
| HTML import | ✅ Sanitized text extraction |
| Import deduplication | ✅ SHA-256 document hashing |
| Source-block identity | ✅ Deterministic IDs/content hashes and source coordinates |
| Authored graph | ✅ Cytoscape layer, unresolved authored targets remain visible |
| Entity candidates | ✅ Deterministic candidates, pending by default |
| Relationship candidates | ✅ Source-bearing candidates, pending by default |
| Human review | ✅ Accept/reject plus audit history |
| Entity operations | ✅ Rename, aliases, pin, merge, split |
| Reviewed graph | ✅ Separate inferred layer; rejected/merged entities excluded |
| Graph communities | ✅ Deterministic connected components over reviewed graph |
| BM25 | ✅ Proper local BM25 channel |
| Local semantic retrieval | ✅ Optional Transformers.js embeddings |
| Persistent vector cache | ✅ Model/version/content-hash keyed IndexedDB cache |
| Graph retrieval | ✅ Reviewed relation/evidence expansion |
| RRF | ✅ BM25/vector/graph Reciprocal Rank Fusion |
| Query routing | ✅ Exact / local / multi-hop / global / temporal |
| Temporal graph constraints | ✅ Common year-window language and reviewed relation validity |
| Multi-hop proof | ✅ Bounded reviewed relationship paths with source block IDs on every hop |
| Query traces | ✅ Persisted + downloadable JSON diagnostics |
| Extractive answer mode | ✅ Citation-bearing evidence answer |
| Claim/citation validation | ✅ Deterministic citation + lexical support gate |
| Local WebLLM | ✅ Optional WebGPU generation, downstream of retrieval |
| Canvas | ✅ Local cards/labels, drag, edges, groups, resize, import/export |
| Saved views | ✅ Table/cards/list/Kanban contracts, property grouping and filters |
| Trash | ✅ Recoverable local note trash |
| Snapshots | ✅ Manual note snapshots and restore |
| Portable workspace | ✅ v2 export/restore; v1 migration supported |
| PWA | ✅ Small offline shell; heavy optional runtimes lazy-cached |
| Evaluation | ✅ Recall@K, MRR, nDCG/path-recall primitives + golden corpus |
| Scale regression | ✅ Synthetic 5,000-note graph/retrieval test |
| Browser smoke tests | ✅ Chromium authoring/import/review/retrieval/Canvas/graph flows |
| Public static deploy | ✅ GitHub Pages workflow included; repository Pages must be enabled for the first deployment |

## How GraphRAG works

EvidenceWeave keeps retrieval channels separate long enough to inspect them, then fuses their rankings:

1. The question is routed as **exact**, **local**, **multi-hop**, **global**, or **temporal**.
2. **BM25** ranks source blocks locally.
3. If enabled, **Transformers.js** embeds the question; source-block vectors are reused from IndexedDB when model version and content hash still match.
4. Reviewed entity anchors and accepted relationships contribute a **graph** channel.
5. Multi-entity questions search bounded reviewed paths. Every relationship hop must retain source-block evidence.
6. Temporal language filters reviewed relationship validity before graph evidence is used.
7. BM25, vector, and graph ranks are combined with **Reciprocal Rank Fusion**.
8. A query trace records the route, channel ranks/scores, reviewed paths, communities, evidence results, and missing-path diagnostics.
9. Evidence-only synthesis remains available everywhere.
10. Optional WebLLM generation receives only retrieved EvidenceWeave sources and is post-validated for citations/support.

A graph connection is never treated as factual proof merely because two nodes are connected. Missing reviewed paths and missing source evidence remain explicit gaps.

## Provenance model

A note block carries stable note identity, heading context and exact character offsets. Imported document blocks add the coordinates available from the source format, for example PDF page number or CSV row number.

Conceptually:

```text
source block
├── id
├── source type / source id
├── title
├── heading path
├── text
├── content hash
├── extractor version
└── source coordinates
    ├── page
    ├── row / columns
    ├── section
    └── start/end offsets
```

Derived entities and relationships point back to source-block IDs. Reviewed relationship paths therefore remain inspectable down to their source evidence.

## Local AI and cost boundary

The default product does not require paid APIs. BM25, graph reasoning, review, query tracing and evidence-only answers run locally.

Optional semantic retrieval uses a Transformers.js model and optional answer generation uses WebLLM. On first use, model/runtime files must be downloaded from their distribution hosts and cached by the browser; download size, browser storage limits, WebGPU support and third-party hosting availability therefore affect those optional modes. EvidenceWeave does **not** claim that network bandwidth, a custom domain, desktop code signing, or third-party hosting can never incur cost.

If local AI cannot load, the workspace remains usable with BM25 + graph + evidence mode.

## Run locally

Prerequisites: Node.js 24 and pnpm 10.15.1 are used by CI.

```bash
pnpm install
pnpm dev
```

Run the full non-browser gate:

```bash
pnpm check
```

Run Chromium end-to-end tests after installing the Playwright browser:

```bash
pnpm --filter @evidenceweave/web exec playwright install chromium
pnpm --filter @evidenceweave/web test:e2e
```

## Deployment

The repository contains a GitHub Pages workflow. The production build accepts `VITE_BASE_PATH`, so a project Page can be served from:

```text
https://<owner>.github.io/evidenceweave-graph-studio/
```

The workflow builds with `/evidenceweave-graph-studio/` as the base, uploads `apps/web/dist`, and deploys through GitHub's Pages artifact/deployment actions. GitHub Pages must be enabled for the repository before the first successful deployment if it is not already enabled.

Heavy PDF/embedding/WebLLM assets are deliberately excluded from the mandatory PWA precache and are cached when used. This keeps installing the core workspace materially smaller than installing every optional ML runtime up front.

## Quality gates

The release pipeline checks:

- strict TypeScript compilation;
- unit tests for workspace/graph/retrieval/provenance/reasoning contracts;
- golden retrieval and sourced-path expectations;
- a synthetic 5,000-note scale regression;
- production Vite/PWA build;
- Chromium end-to-end flows for core user journeys.

Passing these gates is not the same as formal security certification, perfect retrieval quality on every corpus, or exhaustive cross-browser validation.

## Privacy and security boundary

EvidenceWeave has no required application-server upload, login, analytics SDK, or paid model API. Browser site data is still subject to the security of the browser profile, operating system, extensions and device. Clearing site data can erase local data; portable exports and snapshots are therefore important recovery tools.

The current browser v1 is **not** a certified confidential-document environment. See [`SECURITY.md`](SECURITY.md) for the supported threat boundary.

## Known v1 boundaries

These are intentionally not disguised as completed features:

- PDF provenance is page/text based; it does not yet preserve bounding-box coordinates for every glyph/region.
- Claim validation is deterministic citation/lexical support checking, not a trained natural-language-inference verifier.
- Optional local ML depends on browser/WebGPU/WASM capabilities and third-party model-file availability.
- The browser app does not yet provide cryptographic model-file integrity pinning.
- Canvas is a practical local spatial workspace, not yet a full vector-drawing/freehand design tool.
- Tauri desktop packaging, signed native releases, multi-profile enterprise administration and formal at-rest encryption are outside the browser-v1 release.
- Chromium is the automated browser gate today; broader browser/device matrices are a later hardening layer.

## Architecture and documentation

- [`docs/architecture/overview.md`](docs/architecture/overview.md)
- [`docs/workspace-format.md`](docs/workspace-format.md)
- [`docs/privacy.md`](docs/privacy.md)
- [`docs/decisions/0001-local-first-browser-baseline.md`](docs/decisions/0001-local-first-browser-baseline.md)
- [`SECURITY.md`](SECURITY.md)

## Obsidian non-affiliation / clean-room statement

EvidenceWeave is inspired by broadly used local-knowledge, graph, canvas, property-view and linked-note patterns. It is **not affiliated with Obsidian** and does not copy Obsidian source code, proprietary assets, branding, CSS, screenshots, plugin APIs, or proprietary interface implementation.

## License

MIT © 2026 Mohit Bhatnagar. The repository was created under MIT and this implementation preserves that owner-selected license.
