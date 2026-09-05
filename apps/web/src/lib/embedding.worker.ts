/// <reference lib="webworker" />

interface InitMessage { type: "init"; modelId: string; }
interface EmbedMessage { type: "embed"; requestId: string; texts: string[]; }
interface CancelMessage { type: "cancel"; requestId: string; }
type WorkerInput = InitMessage | EmbedMessage | CancelMessage;

let extractor: ((text: string, options: { pooling: string; normalize: boolean }) => Promise<{ tolist(): unknown }>) | undefined;
const cancelled = new Set<string>();

async function initialize(modelId: string) {
  try {
    const { pipeline } = await import("@huggingface/transformers");
    const supportsWebGpu = typeof navigator !== "undefined" && "gpu" in navigator;
    extractor = await pipeline("feature-extraction", modelId, { device: supportsWebGpu ? "webgpu" : "wasm", dtype: "q8" }) as unknown as typeof extractor;
    self.postMessage({ type: "ready", device: supportsWebGpu ? "webgpu" : "wasm" });
  } catch (error) {
    self.postMessage({ type: "error", error: error instanceof Error ? error.message : "Embedding worker initialization failed." });
  }
}

async function embed(requestId: string, texts: string[]) {
  if (!extractor) {
    self.postMessage({ type: "error", requestId, error: "Embedding worker is not initialized." });
    return;
  }
  try {
    const vectors: number[][] = [];
    for (const text of texts) {
      if (cancelled.has(requestId)) { cancelled.delete(requestId); return; }
      const output = await extractor(text, { pooling: "mean", normalize: true });
      const raw = output.tolist();
      const first = Array.isArray(raw) && Array.isArray(raw[0]) ? raw[0] : raw;
      vectors.push((first as number[]).map(Number));
    }
    if (cancelled.has(requestId)) { cancelled.delete(requestId); return; }
    self.postMessage({ type: "result", requestId, vectors });
  } catch (error) {
    self.postMessage({ type: "error", requestId, error: error instanceof Error ? error.message : "Embedding inference failed." });
  }
}

self.addEventListener("message", (event: MessageEvent<WorkerInput>) => {
  const message = event.data;
  if (message.type === "init") { void initialize(message.modelId); return; }
  if (message.type === "cancel") { cancelled.add(message.requestId); return; }
  void embed(message.requestId, message.texts);
});

export {};
