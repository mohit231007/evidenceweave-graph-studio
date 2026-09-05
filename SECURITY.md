# Security Policy

EvidenceWeave Graph Studio is a local-first browser application. The browser-v1 design intentionally avoids a server-side document database, analytics SDK, required login, and required API key.

## Supported version

The current `main` branch and the latest tagged v1 release are the supported lines once v1 is tagged. Security fixes should target supported release code rather than archived experiments.

## Reporting a vulnerability

Please report security issues privately through GitHub's private vulnerability reporting/security advisory features when available. Do not publish proof-of-concept exploits containing user data, private workspace content, or live credentials.

## Trust boundary

EvidenceWeave treats imported documents, Markdown, frontmatter, extracted entities, graph candidates, model output, and portable-workspace files as untrusted input.

The browser-v1 application is designed so that:

- Markdown preview is sanitized with DOMPurify before HTML is inserted into the DOM.
- Imported HTML is treated as source content, not executable application code.
- Core note and derived-knowledge data stay in browser IndexedDB unless the user explicitly imports/exports data or optional local-model runtimes fetch model assets.
- No EvidenceWeave application server receives note/document content in the baseline architecture.
- Inferred entities and relationships stay separate from authored Markdown and remain pending until reviewed.
- Generated answers are downstream of retrieved evidence; they do not mutate authored Markdown automatically.
- Portable restore validates schema shape, document-block containment, inferred-relation endpoints, and relationship provenance before replacing local state.
- Semantic vectors are derived cache data keyed by model/version/content hash and are rebuilt rather than trusted as portable source data.
- Heavy optional PDF/ML runtime assets are lazy-loaded rather than silently included in every PWA installation.

## Outside the application trust boundary

The following can still expose local data and must be secured independently:

- the browser profile and sync configuration;
- installed browser extensions;
- the operating system and device account;
- malware, screen capture, clipboard monitoring, backups, and physical access;
- static-hosting infrastructure serving the application bundle;
- third-party distribution hosts used to download optional local model/runtime files;
- user-exported workspace/canvas/trace files after they leave the browser sandbox.

## Browser-v1 limitations

EvidenceWeave browser v1 is **not** a certified confidential-document environment. In particular, v1 does not claim:

- application-managed encryption at rest beyond protections supplied by the browser/OS;
- cryptographic integrity pinning for every optional model asset;
- signed native desktop binaries;
- enterprise key management, DLP, remote wipe, SSO, role-based administration, or audit-log attestation;
- complete protection against malicious browser extensions or a compromised endpoint;
- exhaustive hostile-file fuzzing for every PDF/DOCX parser path;
- formal security certification or penetration-test coverage.

For sensitive material, use an appropriately managed browser/device, keep portable exports protected, and validate the environment against your organization's security requirements before relying on the application.

## Dependency and release controls

- Dependency versions are captured in the committed `pnpm-lock.yaml`.
- CI and Pages deployment use `pnpm install --frozen-lockfile`.
- TypeScript, unit/evaluation tests, production build, PWA generation, and Chromium end-to-end tests gate changes before merge.
- Optional model generation is not required for core operation, so a model/runtime outage does not need to bypass evidence-mode safeguards.

## Security design notes

See [`docs/privacy.md`](docs/privacy.md), [`docs/architecture/overview.md`](docs/architecture/overview.md), and the repository README for the current data-flow and feature boundaries.
