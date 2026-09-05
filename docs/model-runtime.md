# Local model runtime and trust boundary

EvidenceWeave keeps deterministic BM25, authored/reviewed graph retrieval and extractive evidence available without any model download. Model-backed features are optional and run in the browser when enabled by the user.

## Embedding model

- Runtime: `@huggingface/transformers` 4.2.0.
- Model: `Xenova/all-MiniLM-L6-v2`.
- Pinned revision: `751bff37182d3f1213fa05d7196b954e230abad9`.
- Model card: https://huggingface.co/Xenova/all-MiniLM-L6-v2
- Upstream model: https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2
- The conversion model card identifies Apache-2.0 and states that it is the Transformers.js-compatible ONNX conversion of the upstream model.
- WebGPU is preferred when available; WASM is the compatibility fallback.
- Embedding inference uses a dedicated Web Worker when browser worker startup succeeds. A direct browser fallback exists so lack of worker support does not disable the deterministic core.
- Persisted vectors carry model ID, runtime/model version, source-block content hash, vector dimensions and creation time. A content, model or version mismatch forces a local rebuild.
- Embeddings are deliberately omitted from portable workspace exports and rebuilt on the destination device.

## Optional local named-entity model

- Runtime: `@huggingface/transformers` 4.2.0.
- Conversion model: `Xenova/bert-base-NER`.
- Pinned revision: `24c7e5aba9ae350923357a6f0b92571be34037ec`.
- Conversion card: https://huggingface.co/Xenova/bert-base-NER
- Upstream model: https://huggingface.co/dslim/bert-base-NER
- The conversion card points to the upstream `dslim/bert-base-NER`; the upstream model card identifies MIT as its license.
- This model is **opt in**. First use can be a substantial download.
- Its output is mapped only into pending entity candidates with source-block evidence, confidence and extractor/model revision. It never silently edits authored Markdown or auto-accepts inferred graph edges.
- Deterministic candidates remain the baseline. If a local-model candidate matches an existing deterministic entity type/name, EvidenceWeave suppresses the duplicate rather than replacing the deterministic record.

## Optional local answer generation

- Runtime: `@mlc-ai/web-llm` 0.2.84.
- Browser model ID used by the current Studio: `Llama-3.2-1B-Instruct-q4f16_1-MLC`.
- MLC model repository: https://huggingface.co/mlc-ai/Llama-3.2-1B-Instruct-q4f16_1-MLC
- The model repository identifies this as an MLC/WebLLM conversion of Meta Llama 3.2 1B Instruct. Users are responsible for reviewing the applicable model license/acceptable-use terms for their own deployment.
- Generation is downstream of retrieval: EvidenceWeave retrieves provenance-bearing blocks first, constrains the prompt to those blocks, then validates the generated answer against the evidence. Failure to support a claim is surfaced rather than converted into synthetic evidence.

## Network and privacy boundary

"Local inference" does not mean "zero network requests forever." The first time an optional model is enabled, model/tokenizer/runtime files may be fetched from their external hosting origin and then cached by the browser. Those hosts can observe normal network metadata such as IP address and request headers. EvidenceWeave does not intentionally send workspace note/document text to those model hosts for inference.

The deterministic core does not require those optional model downloads. Users working in restricted or offline environments can keep semantic retrieval, NER and WebLLM disabled and retain lexical retrieval, reviewed graph proof, source provenance and extractive answers.

## Licensing note

Repository and model-card license labels are recorded here for reproducibility; this document is not legal advice and does not make a blanket representation about every training-data right or downstream use case. Review the relevant model card and upstream terms before commercial redistribution or regulated deployment.
