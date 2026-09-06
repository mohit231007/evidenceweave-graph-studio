/// <reference lib="webworker" />

import { browserHasWebGpu, selectLocalModelDevice } from "./runtime-device";

interface InitMessage { type: "init"; modelId: string; revision: string; }
interface ExtractMessage { type: "extract"; requestId: string; texts: string[]; }
interface CancelMessage { type: "cancel"; requestId: string; }
type Input = InitMessage | ExtractMessage | CancelMessage;

interface TokenEntity {
  entity?: string;
  entity_group?: string;
  word?: string;
  score?: number;
  start?: number;
  end?: number;
}

let classifier: ((text: string, options?: Record<string, unknown>) => Promise<TokenEntity[]>) | undefined;
const cancelled = new Set<string>();

async function initialize(modelId: string, revision: string) {
  try {
    const { pipeline } = await import("@huggingface/transformers");
    const device = selectLocalModelDevice(browserHasWebGpu());
    classifier = await pipeline("token-classification", modelId, { device, dtype: "q8", revision }) as unknown as typeof classifier;
    self.postMessage({ type: "ready", modelId, revision, device });
  } catch (error) {
    self.postMessage({ type: "error", error: error instanceof Error ? error.message : "Local NER model initialization failed." });
  }
}

async function extract(requestId: string, texts: string[]) {
  if (!classifier) { self.postMessage({ type: "error", requestId, error: "Local NER worker is not initialized." }); return; }
  try {
    const results: TokenEntity[][] = [];
    for (const text of texts) {
      if (cancelled.has(requestId)) { cancelled.delete(requestId); return; }
      const output = await classifier(text, { aggregation_strategy: "simple" });
      results.push(output.map((item) => ({
        entity: item.entity,
        entity_group: item.entity_group,
        word: item.word,
        score: item.score,
        start: item.start,
        end: item.end
      })));
    }
    if (cancelled.has(requestId)) { cancelled.delete(requestId); return; }
    self.postMessage({ type: "result", requestId, results });
  } catch (error) {
    self.postMessage({ type: "error", requestId, error: error instanceof Error ? error.message : "Local NER inference failed." });
  }
}

self.addEventListener("message", (event: MessageEvent<Input>) => {
  const message = event.data;
  if (message.type === "init") { void initialize(message.modelId, message.revision); return; }
  if (message.type === "cancel") { cancelled.add(message.requestId); return; }
  void extract(message.requestId, message.texts);
});

export {};
