# ADR 0001: Local-first browser baseline

**Status:** Accepted  
**Date:** 2026-09-06

## Decision

The public application will be a static TypeScript PWA whose core workspace, authored graph, search, and extractive evidence mode run in the browser. IndexedDB is the first persistence layer. Optional local ML is additive, never required for core use.

## Why

This supports the product promises of user-owned data, zero required API keys, no central document database, offline use after installation, and bounded $0 hosting for the public demo.

## Consequences

- Device capability and browser storage quotas bound scale.
- Cross-device sync cannot be promised without user-controlled or hosted infrastructure.
- Migrations, export/import, corruption recovery, and performance budgets become product-critical.
- A deterministic non-LLM answer path must always remain available.

## License note

The project proposal recommends Apache-2.0, but the repository owner initialized the repository under MIT. This implementation preserves MIT; changing the project license requires an explicit owner decision.
