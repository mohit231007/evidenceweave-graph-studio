# EvidenceWeave Graph Studio v1.1 — Release Evaluation

Release target: `1.1.0`

This report records the automated release contract used for the browser v1.1 line. It distinguishes measured deterministic behavior from optional model-runtime behavior that is intentionally not downloaded in CI.

## Automated release gate

The v1.1 branch is required to pass, on a frozen pnpm lockfile:

1. strict TypeScript compilation;
2. all Vitest unit, invariant, retrieval, provenance and evaluation suites;
3. production Vite/PWA build;
4. Chromium installation and Playwright end-to-end journeys.

Immediately before the final browser-fix pass, the non-browser gate contained **75 passing tests across 10 test files**. v1.1 adds an explicit WebGPU/WASM device-selection contract, bringing the expected final unit/evaluation count to **76 tests**. The final merge is blocked unless CI confirms the count and every browser journey passes.

## Retrieval quality contract

The deterministic golden corpus covers direct evidence, provenance, a two-hop reviewed relationship path, temporal evidence and a deliberately unsupported question.

Current release assertions:

- Recall@5: **>= 0.75** on relevant golden questions.
- MRR: **>= 0.70**.
- nDCG@5: **>= 0.70**.
- Multi-hop path recall: **1.0** for the two-hop Atlas → OpenAI → Microsoft proof case.
- Deterministic BM25 + reviewed-graph RRF must **match or exceed the best enabled single deterministic channel** for Recall@5, MRR and nDCG@5 before the fused ranking is accepted by the release gate.
- An unrelated non-broad question receives no broad community evidence.
- The unsupported temporal question `What was Apple revenue in 2024?` must return no evidence, no graph path and an explicit `Evidence gap:` extractive response.

The golden corpus is deliberately small and deterministic. These are regression gates, not a claim of universal retrieval quality.

## Graph and review invariants

Seeded property-style tests repeatedly generate review states, paths and Canvas graphs and enforce that:

- an entity review decision persists only while extractor identity remains stable;
- changed entity/relation extractor versions reopen prior decisions to `pending`;
- deleting any source block required by a proof invalidates that proof;
- deleting a Canvas node removes every incident edge while preserving unrelated edges;
- collided relationships produced by entity merges union provenance and confidence;
- conflicting review states on a collided merged relationship reopen the relationship to `pending`;
- accepted relationship state is never created without source-block provenance and accepted, non-merged endpoint entities.

Merge and split mutations retain before/after audit snapshots and can be reversed from the review history.

## Import safety and provenance

Automated tests cover:

- PDF page-level evidence and text extraction in Chromium;
- DOCX paragraph/table extraction in Chromium;
- CSV row/column provenance;
- document → page/section → block containment;
- malformed CSV rejection;
- CSV cell memory bounds;
- unsupported document rejection without source-record creation;
- worker cancellation without partial document/block commit;
- restart/resume of a cancelled import job;
- SHA-256-based duplicate detection before duplicate indexing.

The extraction layer also applies explicit limits for file bytes, PDF pages, CSV rows/columns/cell size, extracted characters and block count.

## Workspace and recovery

Chromium journeys cover:

- authoring, daily notes, local trash and recovery;
- calendar navigation across a year boundary;
- user template persistence across browser reload;
- active-view and active-note restoration;
- saved Kanban views and snapshot recovery;
- Canvas note/document/label nodes, links and grouping;
- removing a trashed note from Canvas and restoring its previous Canvas placement/edge state.

Portable workspace schema v3 retains templates, workspace state, migration records, review audit, query traces and semantic suggestions. v1/v2 bundles normalize to v3. Embeddings are intentionally excluded and rebuilt on the destination device.

## Scale regression

CI creates **5,000 linked synthetic notes**, derives the authored graph and source blocks, and retrieves a tail note. The latest pre-release run before the final browser-fix pass completed that test in approximately **269 ms** on the hosted Linux runner.

This is a regression guard, not a browser-interaction benchmark for every device. Large real workspaces can still be constrained by available RAM, IndexedDB quotas, browser scheduling and optional model runtime size.

## Local-model runtime contract

Optional semantic retrieval and local NER use pinned model repository revisions. The default browser worker device-selection rule is explicit and tested:

- WebGPU present → `webgpu`;
- WebGPU absent → `wasm`.

Model-backed functionality is optional. CI validates the runtime selection, cancellation, cache/versioning and fail-safe contracts but does **not** download and benchmark every model shard on the hosted runner. Therefore this release report does not present a fabricated vector-model latency or quality number.

The deterministic BM25 + reviewed graph + evidence-only path remains usable when optional models cannot load.

## Build characteristics

The pre-release production build successfully emitted the PWA shell plus lazy worker/runtime chunks. A representative pre-release build reported:

- PWA precache: about **907 KiB** across 5 entries;
- embedding worker bundle: about **558 KiB**;
- local NER worker bundle: about **558 KiB**;
- document import worker: about **936 KiB**;
- ONNX Runtime WASM asset: about **23.6 MiB** uncompressed;
- optional WebLLM/library chunk: about **6.0 MiB** minified.

Heavy optional runtime assets are not part of the mandatory offline shell precache.

## Release decision

v1.1 is eligible for merge only when the final clean PR head passes the complete frozen-install, typecheck, 76-test, production/PWA and Chromium end-to-end gate.

Passing this contract means the documented browser v1.1 acceptance criteria are protected by automated regression checks. It does not imply formal security certification, exhaustive browser compatibility, perfect semantic retrieval on arbitrary corpora, or a guarantee that optional model hosting is always available.
