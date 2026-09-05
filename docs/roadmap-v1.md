# EvidenceWeave Graph Studio — v1 execution roadmap

This roadmap converts the project proposal into release gates. EvidenceWeave remains local-first: authored Markdown is never overwritten by inferred knowledge, all derived evidence is provenance-bearing, and optional model features must fail closed when unavailable.

## Gate A — document intelligence
- First-class local document registry with content hashes, format, extractor version and import status.
- Provenance-aware source blocks for Markdown/TXT/CSV/HTML plus adapter contracts for PDF/DOCX.
- Duplicate detection and bounded import limits.
- Structured CSV row provenance and sanitized HTML sections.

## Gate B — inferred graph
- Deterministic entity candidates and relationship candidates.
- Human review states: pending, accepted, rejected.
- Every inferred edge resolves to one or more source blocks.
- Authored and inferred graph layers remain distinct.

## Gate C — hybrid retrieval
- Proper BM25 over source blocks.
- Vector-channel contract with local deterministic fallback and optional browser model provider.
- Graph expansion and Reciprocal Rank Fusion.
- Per-channel contribution trace and missing-evidence refusal.

## Gate D — reasoning and verification
- Multi-hop path proof across authored and accepted inferred edges.
- Temporal metadata filters.
- Evidence-first answer synthesis.
- Claim-to-source validation and coverage reporting.

## Gate E — workspace parity
- Canvas model, daily notes, templates, saved views, trash/snapshots and reversible persistence.

## Gate F — evaluation and release
- Golden retrieval corpus and Recall@K/MRR/nDCG/path-recall metrics.
- Browser smoke tests, accessibility checks and 5k-note baseline.
- Static public deployment with no required backend, account or paid API.
