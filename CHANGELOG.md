# Changelog

All notable EvidenceWeave Graph Studio changes are documented here.

## [1.1.0] - 2026-09-06

### Added

- Worker-backed PDF, DOCX, CSV, HTML, Markdown and text ingestion with progress, cancellation and safe resume/restart semantics.
- PDF page provenance with extracted text-item geometry where available.
- CSV row/column provenance and document → page/section → block containment graphs.
- Import safety limits for file size, PDF pages, CSV rows/columns/cells, extracted characters and source-block count.
- Reusable inverted BM25 index and versioned retrieval contract.
- Dedicated Transformers.js embedding worker with WebGPU preference and WASM fallback.
- Pinned `Xenova/all-MiniLM-L6-v2` embedding revision and model/version/content-hash vector invalidation.
- Global/community and temporal retrieval channels plus exact/local/multi-hop/global/temporal routing.
- Golden-corpus RRF regression gate, nDCG, path-recall and refusal checks.
- Optional pinned local NER second pass; model candidates always remain pending and source-bound.
- Separate semantic-link suggestion layer that never silently becomes an authored or reviewed relationship.
- Review audit undo, reopen controls and reviewed relationship validity editing.
- Conservative relation reconciliation when entity merges collide existing relations; provenance is unioned and conflicting review states reopen to pending.
- Calendar navigation, user templates, persisted active view/note, open tabs and recent-note history.
- Portable workspace schema v3 with v1/v2 migration support, templates, layout state, migration records and semantic suggestions.
- Canvas document nodes, directed links, groups, resizing and drag persistence.
- Note trash now removes active Canvas placements/edges and restores them with the note.
- Expanded Chromium acceptance journeys for PDF/DOCX provenance, malformed input, cancellation/resume, review/audit, Canvas restoration, templates/calendar and persisted workspace state.

### Changed

- Relationship acceptance now requires source-block provenance and accepted, non-merged endpoint entities.
- Broad graph-community fallback is limited to explicit broad/global intent so unrelated queries do not acquire graph evidence.
- Optional model repositories are pinned to explicit revisions rather than tracking mutable default branches.
- Portable exports deliberately omit embeddings and rebuild them on the destination device.
- Studio version advanced from 1.0 to 1.1.

### Security and privacy

- No required EvidenceWeave server, account, analytics SDK or paid model API was introduced.
- Optional model use can contact external model hosting on first download; workspace inference remains browser-side.
- Malformed, unsupported, oversized and cancelled document jobs fail before database commit.

### Known boundaries

- Automated browser coverage is Chromium-first.
- Optional WebLLM generation requires WebGPU.
- Claim support validation is deterministic citation/lexical checking rather than a trained entailment model.
- GitHub Pages deployment requires repository Pages to be enabled once in repository settings before the workflow can publish.
- Tauri desktop packaging, enterprise administration and formal at-rest encryption remain outside the browser 1.1 release.

## [1.0.0] - 2026-09-05

### Added

- Local-first Markdown workspace with IndexedDB persistence.
- Safe note rename and wiki-link rewriting.
- Authored graph, imported-document blocks, deterministic entity/relationship proposals and human review.
- BM25 retrieval, optional local embeddings, reviewed graph evidence, RRF and query traces.
- Source-bearing multi-hop proof and extractive answer verification.
- Optional local WebLLM answer generation.
- Canvas, saved views, trash, snapshots and portable workspace export/restore.
- PWA build, frozen pnpm lockfile, CI, 5,000-note scale regression and Chromium end-to-end tests.
