# EvidenceWeave evaluation contract

EvidenceWeave treats retrieval quality, graph-path correctness and refusal behavior as release gates rather than screenshots.

## Current automated corpus

The repository includes a deterministic golden corpus covering direct lexical retrieval, provenance requirements, a two-hop reviewed graph path, temporal wording, and an out-of-domain negative question. CI measures Recall@K, MRR/nDCG primitives, sourced path recovery and a 5,000-note graph/retrieval baseline.

## Metrics

- **Recall@K**: relevant source blocks present in the first K results.
- **MRR**: reciprocal rank of the first relevant block.
- **nDCG@K**: rank-sensitive relevance quality.
- **Path recall**: required reviewed relation edges recovered for multi-hop proof.
- **Claim coverage**: fraction of answer claims with resolvable citations that pass the current support validator.
- **Refusal accuracy**: unsupported questions must not acquire invented graph paths or fabricated citations.

## Release rule

Hybrid/vector retrieval must not be promoted as an improvement solely because it exists. A pinned model/version gets a documented golden-corpus run, and its hybrid RRF metrics must match or exceed the best enabled single retrieval channel on the target corpus before that model/channel is enabled by default.

The current browser embedding model remains opt-in. BM25 and reviewed graph proof remain the deterministic baseline when model assets are absent.

## Scale baseline

CI constructs 5,000 linked synthetic notes, derives the authored graph and source blocks, and retrieves a note at the tail of the corpus. This is a regression guard, not a substitute for browser interaction profiling; production release still requires Chromium performance traces for large workspaces.
