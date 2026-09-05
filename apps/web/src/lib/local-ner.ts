import type { UnifiedSourceBlock } from "./hybrid";
import type { EntityCandidateRecord } from "./store";

export const DEFAULT_NER_MODEL_ID = "Xenova/bert-base-NER";
export const DEFAULT_NER_MODEL_REVISION = "24c7e5aba9ae350923357a6f0b92571be34037ec";

export interface LocalNerMention {
  label: string;
  text: string;
  score: number;
  start?: number;
  end?: number;
}

export interface LocalNerProvider {
  modelId: string;
  revision: string;
  version: string;
  workerBacked: boolean;
  extract(texts: string[], options?: { signal?: AbortSignal }): Promise<LocalNerMention[][]>;
  dispose?(): void;
}

interface TokenEntity {
  entity?: string;
  entity_group?: string;
  word?: string;
  score?: number;
  start?: number;
  end?: number;
}

const normalize = (value: string) => value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
const slug = (value: string) => normalize(value).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 80);

function cleanWord(value: string): string {
  return value.replace(/^##/, "").replace(/\s+([.,;:!?])/g, "$1").trim();
}

function normalizedLabel(item: TokenEntity): string {
  return (item.entity_group ?? item.entity ?? "").replace(/^[BI]-/, "").toUpperCase();
}

function toMention(item: TokenEntity): LocalNerMention | undefined {
  const text = cleanWord(item.word ?? "");
  const label = normalizedLabel(item);
  if (!text || !label) return undefined;
  return { label, text, score: Number(item.score ?? 0), start: item.start, end: item.end };
}

async function createDirect(modelId: string, revision: string): Promise<LocalNerProvider> {
  const { pipeline } = await import("@huggingface/transformers");
  const supportsWebGpu = typeof navigator !== "undefined" && "gpu" in navigator;
  const classifier = await pipeline("token-classification", modelId, { device: supportsWebGpu ? "webgpu" : "wasm", dtype: "q8", revision });
  return {
    modelId,
    revision,
    version: `transformers.js-4.2.0-ner@${revision}`,
    workerBacked: false,
    async extract(texts, options = {}) {
      const output: LocalNerMention[][] = [];
      for (const text of texts) {
        if (options.signal?.aborted) throw new DOMException("Local NER cancelled.", "AbortError");
        const raw = await classifier(text, { aggregation_strategy: "simple" }) as unknown as TokenEntity[];
        output.push(raw.map(toMention).filter((item): item is LocalNerMention => Boolean(item)));
      }
      return output;
    }
  };
}

interface WorkerMessage {
  type: "ready" | "result" | "error";
  requestId?: string;
  results?: TokenEntity[][];
  error?: string;
}

async function createWorker(modelId: string, revision: string): Promise<LocalNerProvider> {
  const worker = new Worker(new URL("./local-ner.worker.ts", import.meta.url), { type: "module", name: "evidenceweave-local-ner" });
  const pending = new Map<string, { resolve: (results: LocalNerMention[][]) => void; reject: (error: Error) => void }>();
  let disposed = false;
  const ready = new Promise<void>((resolve, reject) => {
    const fail = (message: string) => { worker.terminate(); reject(new Error(message)); };
    worker.onerror = (event) => fail(event.message || "Local NER worker failed to initialize.");
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === "ready") { resolve(); return; }
      if (message.type === "error" && !message.requestId) { fail(message.error ?? "Local NER worker failed to initialize."); return; }
      if (!message.requestId) return;
      const request = pending.get(message.requestId);
      if (!request) return;
      pending.delete(message.requestId);
      if (message.type === "result" && message.results) {
        request.resolve(message.results.map((items) => items.map(toMention).filter((item): item is LocalNerMention => Boolean(item))));
      } else request.reject(new Error(message.error ?? "Local NER worker failed."));
    };
  });
  worker.postMessage({ type: "init", modelId, revision });
  await ready;
  return {
    modelId,
    revision,
    version: `transformers.js-4.2.0-ner-worker@${revision}`,
    workerBacked: true,
    extract(texts, options = {}) {
      if (disposed) return Promise.reject(new Error("Local NER worker has been disposed."));
      const requestId = crypto.randomUUID();
      return new Promise<LocalNerMention[][]>((resolve, reject) => {
        const abort = () => {
          pending.delete(requestId);
          worker.postMessage({ type: "cancel", requestId });
          reject(new DOMException("Local NER cancelled.", "AbortError"));
        };
        if (options.signal?.aborted) { abort(); return; }
        options.signal?.addEventListener("abort", abort, { once: true });
        pending.set(requestId, {
          resolve: (value) => { options.signal?.removeEventListener("abort", abort); resolve(value); },
          reject: (error) => { options.signal?.removeEventListener("abort", abort); reject(error); }
        });
        worker.postMessage({ type: "extract", requestId, texts });
      });
    },
    dispose() {
      disposed = true;
      worker.terminate();
      for (const request of pending.values()) request.reject(new Error("Local NER worker disposed."));
      pending.clear();
    }
  };
}

export async function createLocalNerProvider(modelId = DEFAULT_NER_MODEL_ID, revision = DEFAULT_NER_MODEL_REVISION): Promise<LocalNerProvider> {
  if (typeof Worker !== "undefined") {
    try { return await createWorker(modelId, revision); }
    catch { /* fall through to deterministic browser fallback */ }
  }
  return createDirect(modelId, revision);
}

function entityType(label: string): EntityCandidateRecord["entityType"] | undefined {
  if (label === "PER" || label === "PERSON") return "person";
  if (label === "ORG" || label === "ORGANIZATION") return "organization";
  if (label === "LOC" || label === "LOCATION") return "place";
  if (label === "MISC") return "topic";
  return undefined;
}

export async function extractLocalModelEntityCandidates(
  blocks: UnifiedSourceBlock[],
  provider: LocalNerProvider,
  options: { signal?: AbortSignal; minConfidence?: number; maxBlocks?: number; onProgress?: (completed: number, total: number) => void } = {}
): Promise<EntityCandidateRecord[]> {
  const maxBlocks = Math.max(1, Math.min(options.maxBlocks ?? 500, 2000));
  const minConfidence = Math.max(0.5, Math.min(options.minConfidence ?? 0.7, 0.99));
  const selected = blocks.filter((block) => block.text.trim()).slice(0, maxBlocks);
  const byKey = new Map<string, EntityCandidateRecord>();
  const extractorVersion = `local-ner:${provider.modelId}@${provider.revision}`;
  const now = new Date().toISOString();
  const batchSize = 8;
  for (let offset = 0; offset < selected.length; offset += batchSize) {
    if (options.signal?.aborted) throw new DOMException("Local NER cancelled.", "AbortError");
    const batch = selected.slice(offset, offset + batchSize);
    const outputs = await provider.extract(batch.map((block) => block.text.slice(0, 4000)), { signal: options.signal });
    batch.forEach((block, index) => {
      for (const mention of outputs[index] ?? []) {
        const type = entityType(mention.label);
        const name = mention.text.trim();
        if (!type || mention.score < minConfidence || name.length < 2 || name.length > 120) continue;
        const key = `${type}:${normalize(name)}`;
        const existing = byKey.get(key);
        if (existing) {
          if (!existing.evidenceBlockIds.includes(block.id)) existing.evidenceBlockIds.push(block.id);
          existing.confidence = Math.max(existing.confidence, mention.score);
        } else {
          byKey.set(key, {
            id: `model-entity-${type}-${slug(name)}`,
            canonicalName: name,
            normalizedName: normalize(name),
            entityType: type,
            evidenceBlockIds: [block.id],
            confidence: mention.score,
            extractorVersion,
            status: "pending",
            aliases: [],
            updatedAt: now
          });
        }
      }
    });
    options.onProgress?.(Math.min(offset + batch.length, selected.length), selected.length);
  }
  return [...byKey.values()].sort((left, right) => right.confidence - left.confidence || left.canonicalName.localeCompare(right.canonicalName));
}
