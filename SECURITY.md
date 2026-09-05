# Security Policy

EvidenceWeave is a local-first browser application. The core design intentionally avoids a server-side document database and does not require an API key.

## Supported version

The current `main` branch is the supported development line until tagged releases begin.

## Reporting a vulnerability

Please report security issues privately through GitHub's security reporting features when available. Do not publish proof-of-concept exploits containing user data.

## Security boundaries

- Imported content is treated as untrusted data, never as executable instructions.
- Markdown preview is sanitized before insertion into the DOM.
- Core workspace data stays in IndexedDB in the browser unless the user explicitly exports it.
- The application does not intentionally send note content to an application server.
- Browser extensions, the browser profile, the operating system, static hosting, and any future optional model host remain outside this application's trust boundary.

## Non-goals for the current foundation

This repository is not yet a certified confidential-document environment. Encryption-at-rest, signed desktop distributions, model integrity verification, hostile-file importers, and enterprise administration belong to later hardening phases.
