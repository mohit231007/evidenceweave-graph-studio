/// <reference lib="webworker" />

import { ingestBytes, type DocumentImportProgress } from "./documents";

interface StartMessage {
  type: "start";
  jobId: string;
  name: string;
  mimeType: string;
  buffer: ArrayBuffer;
}

interface CancelMessage {
  type: "cancel";
  jobId: string;
}

type WorkerInput = StartMessage | CancelMessage;

const controllers = new Map<string, AbortController>();

self.addEventListener("message", (event: MessageEvent<WorkerInput>) => {
  const message = event.data;
  if (message.type === "cancel") {
    controllers.get(message.jobId)?.abort();
    return;
  }

  const controller = new AbortController();
  controllers.set(message.jobId, controller);
  void ingestBytes(message.name, message.mimeType, message.buffer, {
    signal: controller.signal,
    onProgress: (progress: DocumentImportProgress) => {
      self.postMessage({ type: "progress", jobId: message.jobId, progress });
    }
  }).then((bundle) => {
    if (controller.signal.aborted) {
      self.postMessage({ type: "cancelled", jobId: message.jobId });
      return;
    }
    self.postMessage({ type: "complete", jobId: message.jobId, bundle });
  }).catch((error: unknown) => {
    const aborted = controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
    if (aborted) self.postMessage({ type: "cancelled", jobId: message.jobId });
    else self.postMessage({ type: "error", jobId: message.jobId, error: error instanceof Error ? error.message : "Document worker failed." });
  }).finally(() => controllers.delete(message.jobId));
});

export {};
