import { ingestFile, type DocumentImportBundle, type DocumentImportProgress } from "./documents";

export type DocumentImportJobStatus = "idle" | "running" | "cancelled" | "completed" | "failed";

export interface DocumentImportJobSnapshot {
  id: string;
  fileName: string;
  status: DocumentImportJobStatus;
  progress?: DocumentImportProgress;
  error?: string;
}

interface WorkerProgressMessage {
  type: "progress";
  jobId: string;
  progress: DocumentImportProgress;
}
interface WorkerCompleteMessage {
  type: "complete";
  jobId: string;
  bundle: DocumentImportBundle;
}
interface WorkerErrorMessage {
  type: "error";
  jobId: string;
  error: string;
}
interface WorkerCancelledMessage {
  type: "cancelled";
  jobId: string;
}
type WorkerOutput = WorkerProgressMessage | WorkerCompleteMessage | WorkerErrorMessage | WorkerCancelledMessage;

export class DocumentImportJob {
  readonly id = crypto.randomUUID();
  readonly file: File;
  private worker?: Worker;
  private abortController?: AbortController;
  private listeners = new Set<(snapshot: DocumentImportJobSnapshot) => void>();
  private snapshotValue: DocumentImportJobSnapshot;

  constructor(file: File) {
    this.file = file;
    this.snapshotValue = { id: this.id, fileName: file.name, status: "idle" };
  }

  get snapshot(): DocumentImportJobSnapshot {
    return { ...this.snapshotValue };
  }

  subscribe(listener: (snapshot: DocumentImportJobSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  private publish(next: Partial<DocumentImportJobSnapshot>) {
    this.snapshotValue = { ...this.snapshotValue, ...next };
    this.listeners.forEach((listener) => listener(this.snapshot));
  }

  async start(): Promise<DocumentImportBundle> {
    if (this.snapshotValue.status === "running") throw new Error("Document import job is already running.");
    this.worker?.terminate();
    this.worker = undefined;
    this.abortController = new AbortController();
    this.publish({ status: "running", progress: { phase: "validating", completed: 0, total: 1, detail: this.file.name }, error: undefined });

    if (typeof Worker === "undefined") {
      try {
        const bundle = await ingestFile(this.file, {
          signal: this.abortController.signal,
          onProgress: (progress) => this.publish({ progress })
        });
        this.publish({ status: "completed" });
        return bundle;
      } catch (error) {
        const aborted = this.abortController.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
        this.publish(aborted ? { status: "cancelled", error: undefined } : { status: "failed", error: error instanceof Error ? error.message : "Import failed." });
        throw error;
      }
    }

    const buffer = await this.file.arrayBuffer();
    if (this.abortController.signal.aborted) {
      this.publish({ status: "cancelled" });
      throw new DOMException("Document import cancelled.", "AbortError");
    }

    return new Promise<DocumentImportBundle>((resolve, reject) => {
      const worker = new Worker(new URL("./document-import.worker.ts", import.meta.url), { type: "module", name: `evidenceweave-import-${this.id}` });
      this.worker = worker;
      const cleanup = () => {
        worker.terminate();
        if (this.worker === worker) this.worker = undefined;
      };
      worker.onmessage = (event: MessageEvent<WorkerOutput>) => {
        const message = event.data;
        if (message.jobId !== this.id) return;
        if (message.type === "progress") {
          this.publish({ progress: message.progress });
          return;
        }
        if (message.type === "complete") {
          cleanup();
          this.publish({ status: "completed" });
          resolve(message.bundle);
          return;
        }
        if (message.type === "cancelled") {
          cleanup();
          this.publish({ status: "cancelled", error: undefined });
          reject(new DOMException("Document import cancelled.", "AbortError"));
          return;
        }
        cleanup();
        this.publish({ status: "failed", error: message.error });
        reject(new Error(message.error));
      };
      worker.onerror = (event) => {
        cleanup();
        const message = event.message || "Document worker failed.";
        this.publish({ status: "failed", error: message });
        reject(new Error(message));
      };
      worker.postMessage({ type: "start", jobId: this.id, name: this.file.name, mimeType: this.file.type || "application/octet-stream", buffer }, [buffer]);
    });
  }

  cancel() {
    if (this.snapshotValue.status !== "running") return;
    this.abortController?.abort();
    this.worker?.postMessage({ type: "cancel", jobId: this.id });
    this.worker?.terminate();
    this.worker = undefined;
    this.publish({ status: "cancelled", error: undefined });
  }

  resume(): Promise<DocumentImportBundle> {
    if (this.snapshotValue.status !== "cancelled" && this.snapshotValue.status !== "failed") throw new Error("Only cancelled or failed import jobs can be resumed.");
    return this.start();
  }
}

export function createDocumentImportJob(file: File): DocumentImportJob {
  return new DocumentImportJob(file);
}
