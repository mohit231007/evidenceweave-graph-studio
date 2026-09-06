/// <reference types="vite/client" />

import type { DocumentBlockRecord, DocumentFormat, SourceBounds, SourceDocumentRecord, SourceLocation } from "./store";

export const DOCUMENT_EXTRACTOR_VERSION = "document-ingest-v2";
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
export const MAX_CSV_ROWS = 100_000;
export const MAX_CSV_COLUMNS = 500;
export const MAX_CSV_CELL_CHARS = 64_000;
export const MAX_PDF_PAGES = 1_000;
export const MAX_BLOCK_CHARS = 1_200;
export const MAX_BLOCKS_PER_DOCUMENT = 150_000;
export const MAX_EXTRACTED_CHARS = 40_000_000;
export const MAX_HTML_NODES = 100_000;

export interface DocumentImportBundle {
  document: SourceDocumentRecord;
  blocks: DocumentBlockRecord[];
  warnings: string[];
}

export type DocumentImportPhase = "validating" | "extracting" | "finalizing";
export interface DocumentImportProgress {
  phase: DocumentImportPhase;
  completed: number;
  total: number;
  detail?: string;
}

export interface DocumentIngestOptions {
  signal?: AbortSignal;
  onProgress?: (progress: DocumentImportProgress) => void;
}

export interface DocumentContainmentNode {
  id: string;
  kind: "document" | "page" | "section" | "block";
  label: string;
  documentId: string;
  blockId?: string;
}

export interface DocumentContainmentEdge {
  id: string;
  source: string;
  target: string;
  relation: "contains";
}

export interface DocumentContainmentGraph {
  nodes: DocumentContainmentNode[];
  edges: DocumentContainmentEdge[];
}

const extensionOf = (name: string) => name.toLocaleLowerCase().split(".").pop() ?? "";
const normalizeText = (value: string) => value.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
const report = (options: DocumentIngestOptions, phase: DocumentImportPhase, completed: number, total: number, detail?: string) => options.onProgress?.({ phase, completed, total, detail });

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw new DOMException("Document import cancelled.", "AbortError");
}

export async function sha256Hex(value: string | Uint8Array | ArrayBuffer): Promise<string> {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value instanceof Uint8Array
      ? Uint8Array.from(value)
      : new Uint8Array(value.slice(0));
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function detectFormat(name: string, mimeType = ""): DocumentFormat | undefined {
  const extension = extensionOf(name);
  if (extension === "md" || mimeType === "text/markdown") return "markdown";
  if (extension === "txt" || mimeType === "text/plain") return "text";
  if (extension === "csv" || mimeType.includes("csv")) return "csv";
  if (["html", "htm"].includes(extension) || mimeType.includes("html")) return "html";
  if (extension === "pdf" || mimeType === "application/pdf") return "pdf";
  if (extension === "docx" || mimeType.includes("wordprocessingml")) return "docx";
  return undefined;
}

function splitText(text: string, maxChars = MAX_BLOCK_CHARS): { text: string; start: number; end: number }[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  const blocks: { text: string; start: number; end: number }[] = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    let end = Math.min(normalized.length, cursor + maxChars);
    if (end < normalized.length) {
      const candidate = normalized.slice(cursor, end);
      const boundary = Math.max(candidate.lastIndexOf("\n\n"), candidate.lastIndexOf(". "), candidate.lastIndexOf("; "));
      if (boundary > maxChars * 0.55) end = cursor + boundary + 1;
    }
    const chunk = normalized.slice(cursor, end).trim();
    if (chunk) {
      const start = normalized.indexOf(chunk, cursor);
      blocks.push({ text: chunk, start, end: start + chunk.length });
    }
    if (end >= normalized.length) break;
    cursor = end;
  }
  return blocks;
}

async function makeBlock(
  document: SourceDocumentRecord,
  text: string,
  headingPath: string[],
  location: SourceLocation,
  suffix: string
): Promise<DocumentBlockRecord> {
  const contentHash = await sha256Hex(text);
  return {
    id: `${document.id}::${suffix}::${contentHash.slice(0, 12)}`,
    documentId: document.id,
    documentTitle: document.name,
    format: document.format,
    headingPath,
    text,
    location,
    contentHash,
    extractorVersion: DOCUMENT_EXTRACTOR_VERSION
  };
}

async function documentRecord(name: string, mimeType: string, bytes: Uint8Array, format: DocumentFormat): Promise<SourceDocumentRecord> {
  const sha256 = await sha256Hex(bytes);
  return {
    id: `doc-${sha256.slice(0, 24)}`,
    name,
    format,
    mimeType,
    size: bytes.byteLength,
    sha256,
    importedAt: new Date().toISOString(),
    extractorName: "EvidenceWeave browser importer",
    extractorVersion: DOCUMENT_EXTRACTOR_VERSION,
    status: "indexed"
  };
}

function validateExtractedBlocks(blocks: DocumentBlockRecord[]) {
  if (blocks.length > MAX_BLOCKS_PER_DOCUMENT) throw new Error(`Document exceeds the ${MAX_BLOCKS_PER_DOCUMENT.toLocaleString()} extracted-block safety limit.`);
  const chars = blocks.reduce((sum, block) => sum + block.text.length, 0);
  if (chars > MAX_EXTRACTED_CHARS) throw new Error(`Document exceeds the ${MAX_EXTRACTED_CHARS.toLocaleString()} extracted-character safety limit.`);
  if (blocks.some((block) => block.text.length > MAX_BLOCK_CHARS * 1.2)) throw new Error("Importer emitted an unexpectedly large source block.");
}

async function ingestPlain(document: SourceDocumentRecord, text: string, options: DocumentIngestOptions): Promise<DocumentBlockRecord[]> {
  if (text.length > MAX_EXTRACTED_CHARS) throw new Error(`Text exceeds the ${MAX_EXTRACTED_CHARS.toLocaleString()} extracted-character safety limit.`);
  const chunks = splitText(text);
  const blocks: DocumentBlockRecord[] = [];
  for (const [index, chunk] of chunks.entries()) {
    throwIfAborted(options.signal);
    blocks.push(await makeBlock(document, chunk.text, [], { startOffset: chunk.start, endOffset: chunk.end }, `text-${index + 1}`));
    report(options, "extracting", index + 1, Math.max(1, chunks.length), `text block ${index + 1}`);
  }
  return blocks;
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
      if (cell.length > MAX_CSV_CELL_CHARS) throw new Error(`CSV cell exceeds the ${MAX_CSV_CELL_CHARS.toLocaleString()} character safety limit.`);
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ",") { row.push(cell); cell = ""; continue; }
    if (char === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; continue; }
    cell += char;
    if (cell.length > MAX_CSV_CELL_CHARS) throw new Error(`CSV cell exceeds the ${MAX_CSV_CELL_CHARS.toLocaleString()} character safety limit.`);
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field.");
  row.push(cell.replace(/\r$/, ""));
  if (row.some((value) => value.length) || !rows.length) rows.push(row);
  return rows;
}

async function ingestCsv(document: SourceDocumentRecord, text: string, options: DocumentIngestOptions): Promise<DocumentBlockRecord[]> {
  const rows = parseCsvRows(text);
  if (rows.length > MAX_CSV_ROWS + 1) throw new Error(`CSV exceeds the ${MAX_CSV_ROWS.toLocaleString()} row safety limit.`);
  if ((rows[0]?.length ?? 0) > MAX_CSV_COLUMNS) throw new Error(`CSV exceeds the ${MAX_CSV_COLUMNS.toLocaleString()} column safety limit.`);
  const headers = rows[0].map((header, index) => header.trim() || `column_${index + 1}`);
  const blocks: DocumentBlockRecord[] = [];
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    throwIfAborted(options.signal);
    const row = rows[rowIndex];
    if (row.length > MAX_CSV_COLUMNS) throw new Error(`CSV row ${rowIndex + 1} exceeds the ${MAX_CSV_COLUMNS.toLocaleString()} column safety limit.`);
    if (!row.some((cell) => cell.trim())) continue;
    const pairs = headers.map((header, index) => `${header}: ${row[index] ?? ""}`);
    const textBlock = pairs.join("\n");
    blocks.push(await makeBlock(document, textBlock, ["CSV row"], { row: rowIndex + 1, columns: headers }, `row-${rowIndex + 1}`));
    if (blocks.length > MAX_BLOCKS_PER_DOCUMENT) throw new Error(`CSV exceeds the ${MAX_BLOCKS_PER_DOCUMENT.toLocaleString()} extracted-block safety limit.`);
    report(options, "extracting", rowIndex, Math.max(1, rows.length - 1), `row ${rowIndex + 1}`);
  }
  return blocks;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripHtml(html: string): string {
  return decodeEntities(html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/?(?:p|div|section|article|main|aside|header|footer|li|tr|h[1-6]|br)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " "));
}

interface HtmlSection { tag: string; text: string; section: string; }

function regexHtmlSections(html: string): HtmlSection[] {
  const safe = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  const sections: HtmlSection[] = [];
  const pattern = /<(h[1-6]|p|li|td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of safe.matchAll(pattern)) {
    const text = normalizeText(decodeEntities(match[2].replace(/<[^>]+>/g, " ")));
    if (!text) continue;
    const tag = match[1].toLocaleLowerCase();
    sections.push({ tag, text, section: `${tag}-${sections.length + 1}` });
    if (sections.length > MAX_HTML_NODES) throw new Error(`HTML exceeds the ${MAX_HTML_NODES.toLocaleString()} indexable-node safety limit.`);
  }
  return sections;
}

function browserHtmlSections(html: string): HtmlSection[] {
  if (typeof DOMParser === "undefined") return regexHtmlSections(html);
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("script,style,iframe,object,embed").forEach((node) => node.remove());
  const nodes = [...parsed.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,td,th")];
  if (nodes.length > MAX_HTML_NODES) throw new Error(`HTML exceeds the ${MAX_HTML_NODES.toLocaleString()} indexable-node safety limit.`);
  return nodes.map((node, index) => ({
    tag: node.tagName.toLocaleLowerCase(),
    text: normalizeText(node.textContent ?? ""),
    section: `${node.tagName.toLocaleLowerCase()}-${index + 1}`
  })).filter((item) => item.text);
}

async function ingestHtml(document: SourceDocumentRecord, html: string, options: DocumentIngestOptions): Promise<DocumentBlockRecord[]> {
  const sections = browserHtmlSections(html);
  if (!sections.length) return ingestPlain(document, stripHtml(html), options);
  const headingPath: string[] = [];
  const blocks: DocumentBlockRecord[] = [];
  for (const [index, item] of sections.entries()) {
    throwIfAborted(options.signal);
    const heading = item.tag.match(/^h([1-6])$/);
    if (heading) {
      const level = Number(heading[1]);
      headingPath.splice(level - 1);
      headingPath[level - 1] = item.text;
      continue;
    }
    const label = item.tag === "td" || item.tag === "th" ? `table-${item.section}` : item.section;
    for (const [chunkIndex, chunk] of splitText(item.text).entries()) {
      blocks.push(await makeBlock(document, chunk.text, headingPath.filter(Boolean), { section: label, startOffset: chunk.start, endOffset: chunk.end }, `${label}-${chunkIndex + 1}`));
    }
    report(options, "extracting", index + 1, sections.length, label);
  }
  return blocks;
}

interface PdfTextItemLike {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
}

interface PositionedText {
  start: number;
  end: number;
  bounds?: SourceBounds;
}

function itemBounds(item: PdfTextItemLike, page: number): SourceBounds | undefined {
  const transform = item.transform;
  if (!transform || transform.length < 6) return undefined;
  const height = Math.abs(item.height ?? Math.hypot(transform[2] ?? 0, transform[3] ?? 0));
  const width = Math.abs(item.width ?? 0);
  if (![transform[4], transform[5], width, height].every(Number.isFinite)) return undefined;
  return { page, x: transform[4], y: transform[5], width, height, unit: "pdf-point", origin: "bottom-left" };
}

function boundsForRange(items: PositionedText[], start: number, end: number): SourceBounds[] | undefined {
  const selected = items.filter((item) => item.end > start && item.start < end).map((item) => item.bounds).filter((value): value is SourceBounds => Boolean(value));
  if (!selected.length) return undefined;
  const page = selected[0].page;
  const minX = Math.min(...selected.map((item) => item.x));
  const minY = Math.min(...selected.map((item) => item.y));
  const maxX = Math.max(...selected.map((item) => item.x + item.width));
  const maxY = Math.max(...selected.map((item) => item.y + item.height));
  return [{ page, x: minX, y: minY, width: Math.max(0, maxX - minX), height: Math.max(0, maxY - minY), unit: "pdf-point", origin: "bottom-left" }];
}

async function ingestPdf(document: SourceDocumentRecord, bytes: Uint8Array, options: DocumentIngestOptions): Promise<DocumentBlockRecord[]> {
  const pdfjs = await import("pdfjs-dist");
  const workerModule = await import("pdfjs-dist/build/pdf.worker.mjs?worker");
  if (!pdfjs.GlobalWorkerOptions.workerPort) pdfjs.GlobalWorkerOptions.workerPort = new workerModule.default();
  const task = pdfjs.getDocument({ data: bytes });
  const pdf = await task.promise;
  if (pdf.numPages > MAX_PDF_PAGES) {
    await task.destroy();
    throw new Error(`PDF exceeds the ${MAX_PDF_PAGES.toLocaleString()} page safety limit.`);
  }
  const blocks: DocumentBlockRecord[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      throwIfAborted(options.signal);
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const pieces: string[] = [];
      const positioned: PositionedText[] = [];
      let cursor = 0;
      for (const raw of content.items as unknown as PdfTextItemLike[]) {
        const value = raw.str ?? "";
        if (!value) continue;
        if (pieces.length) { pieces.push(" "); cursor += 1; }
        const start = cursor;
        pieces.push(value);
        cursor += value.length;
        positioned.push({ start, end: cursor, bounds: itemBounds(raw, pageNumber) });
      }
      const text = normalizeText(pieces.join(""));
      if (text.length > MAX_EXTRACTED_CHARS) throw new Error(`PDF page ${pageNumber} exceeds the extracted-character safety limit.`);
      for (const [index, chunk] of splitText(text).entries()) {
        blocks.push(await makeBlock(document, chunk.text, [`Page ${pageNumber}`], {
          page: pageNumber,
          startOffset: chunk.start,
          endOffset: chunk.end,
          bounds: boundsForRange(positioned, chunk.start, chunk.end)
        }, `page-${pageNumber}-${index + 1}`));
      }
      if (blocks.length > MAX_BLOCKS_PER_DOCUMENT) throw new Error(`PDF exceeds the ${MAX_BLOCKS_PER_DOCUMENT.toLocaleString()} extracted-block safety limit.`);
      page.cleanup();
      report(options, "extracting", pageNumber, pdf.numPages, `page ${pageNumber}`);
    }
  } finally {
    await task.destroy();
  }
  return blocks;
}

async function ingestDocx(document: SourceDocumentRecord, buffer: ArrayBuffer, options: DocumentIngestOptions): Promise<DocumentBlockRecord[]> {
  throwIfAborted(options.signal);
  const mammoth = await import("mammoth/mammoth.browser");
  const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
  if (result.value.length > MAX_EXTRACTED_CHARS) throw new Error(`DOCX exceeds the ${MAX_EXTRACTED_CHARS.toLocaleString()} extracted-character safety limit.`);
  return ingestHtml(document, result.value, options);
}

export async function ingestBytes(name: string, mimeType: string, buffer: ArrayBuffer, options: DocumentIngestOptions = {}): Promise<DocumentImportBundle> {
  throwIfAborted(options.signal);
  report(options, "validating", 0, 1, name);
  if (buffer.byteLength > MAX_DOCUMENT_BYTES) throw new Error(`Document exceeds the ${Math.floor(MAX_DOCUMENT_BYTES / 1024 / 1024)} MiB safety limit.`);
  const format = detectFormat(name, mimeType);
  if (!format) throw new Error(`Unsupported document type: ${name}`);
  const bytes = new Uint8Array(buffer);
  const document = await documentRecord(name, mimeType, bytes, format);
  report(options, "validating", 1, 1, `${format} · ${document.sha256.slice(0, 12)}`);
  const warnings: string[] = [];
  let blocks: DocumentBlockRecord[];
  if (format === "pdf") blocks = await ingestPdf(document, bytes, options);
  else if (format === "docx") blocks = await ingestDocx(document, buffer, options);
  else {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    if (text.length > MAX_EXTRACTED_CHARS) throw new Error(`Document exceeds the ${MAX_EXTRACTED_CHARS.toLocaleString()} extracted-character safety limit.`);
    if (format === "csv") blocks = await ingestCsv(document, text, options);
    else if (format === "html") blocks = await ingestHtml(document, text, options);
    else blocks = await ingestPlain(document, text, options);
  }
  throwIfAborted(options.signal);
  report(options, "finalizing", 0, 1, "validating provenance");
  validateExtractedBlocks(blocks);
  if (!blocks.length) warnings.push("No indexable text was extracted from this document.");
  report(options, "finalizing", 1, 1, `${blocks.length} source blocks`);
  return { document, blocks, warnings };
}

export async function ingestFile(file: File, options: DocumentIngestOptions = {}): Promise<DocumentImportBundle> {
  throwIfAborted(options.signal);
  if (typeof Worker === "undefined") return ingestBytes(file.name, file.type || "application/octet-stream", await file.arrayBuffer(), options);
  const buffer = await file.arrayBuffer();
  throwIfAborted(options.signal);
  const jobId = crypto.randomUUID();
  return new Promise<DocumentImportBundle>((resolve, reject) => {
    const worker = new Worker(new URL("./document-import.worker.ts", import.meta.url), { type: "module", name: `evidenceweave-import-${jobId}` });
    let settled = false;
    const cleanup = () => {
      worker.terminate();
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (callback: () => void) => { if (settled) return; settled = true; cleanup(); callback(); };
    const onAbort = () => {
      worker.postMessage({ type: "cancel", jobId });
      finish(() => reject(new DOMException("Document import cancelled.", "AbortError")));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<{ type: string; jobId: string; progress?: DocumentImportProgress; bundle?: DocumentImportBundle; error?: string }>) => {
      const message = event.data;
      if (message.jobId !== jobId) return;
      if (message.type === "progress" && message.progress) { options.onProgress?.(message.progress); return; }
      if (message.type === "complete" && message.bundle) { finish(() => resolve(message.bundle!)); return; }
      if (message.type === "cancelled") { finish(() => reject(new DOMException("Document import cancelled.", "AbortError"))); return; }
      if (message.type === "error") finish(() => reject(new Error(message.error || "Document import failed.")));
    };
    worker.onerror = (event) => finish(() => reject(new Error(event.message || "Document import worker failed.")));
    worker.postMessage({ type: "start", jobId, name: file.name, mimeType: file.type || "application/octet-stream", buffer }, [buffer]);
  });
}

export function formatLocation(location: SourceLocation): string {
  const parts: string[] = [];
  if (location.page) parts.push(`page ${location.page}`);
  if (location.row) parts.push(`row ${location.row}`);
  if (location.section) parts.push(location.section);
  if (location.startOffset !== undefined && location.endOffset !== undefined) parts.push(`chars ${location.startOffset}–${location.endOffset}`);
  if (location.bounds?.length) parts.push(`${location.bounds.length} source region${location.bounds.length === 1 ? "" : "s"}`);
  return parts.join(" · ") || "document block";
}

export function buildDocumentContainment(document: SourceDocumentRecord, blocks: DocumentBlockRecord[]): DocumentContainmentGraph {
  const nodes = new Map<string, DocumentContainmentNode>();
  const edges = new Map<string, DocumentContainmentEdge>();
  const documentNodeId = `document:${document.id}`;
  nodes.set(documentNodeId, { id: documentNodeId, kind: "document", label: document.name, documentId: document.id });

  for (const block of blocks.filter((item) => item.documentId === document.id)) {
    let parentId = documentNodeId;
    if (block.location.page) {
      const pageId = `${documentNodeId}:page:${block.location.page}`;
      nodes.set(pageId, { id: pageId, kind: "page", label: `Page ${block.location.page}`, documentId: document.id });
      const edgeId = `${parentId}->${pageId}`;
      edges.set(edgeId, { id: edgeId, source: parentId, target: pageId, relation: "contains" });
      parentId = pageId;
    } else if (block.location.section || block.headingPath.length) {
      const label = block.location.section ?? block.headingPath.join(" > ");
      const sectionId = `${documentNodeId}:section:${encodeURIComponent(label)}`;
      nodes.set(sectionId, { id: sectionId, kind: "section", label, documentId: document.id });
      const edgeId = `${parentId}->${sectionId}`;
      edges.set(edgeId, { id: edgeId, source: parentId, target: sectionId, relation: "contains" });
      parentId = sectionId;
    }
    const blockId = `block:${block.id}`;
    nodes.set(blockId, { id: blockId, kind: "block", label: formatLocation(block.location), documentId: document.id, blockId: block.id });
    const edgeId = `${parentId}->${blockId}`;
    edges.set(edgeId, { id: edgeId, source: parentId, target: blockId, relation: "contains" });
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
