/// <reference types="vite/client" />

import type { DocumentBlockRecord, DocumentFormat, SourceDocumentRecord, SourceLocation } from "./store";

export const DOCUMENT_EXTRACTOR_VERSION = "document-ingest-v1";
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
export const MAX_CSV_ROWS = 100_000;
export const MAX_PDF_PAGES = 1_000;
export const MAX_BLOCK_CHARS = 1_200;

export interface DocumentImportBundle {
  document: SourceDocumentRecord;
  blocks: DocumentBlockRecord[];
  warnings: string[];
}

const extensionOf = (name: string) => name.toLocaleLowerCase().split(".").pop() ?? "";
const normalizeText = (value: string) => value.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();

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

async function ingestPlain(document: SourceDocumentRecord, text: string): Promise<DocumentBlockRecord[]> {
  const blocks: DocumentBlockRecord[] = [];
  for (const [index, chunk] of splitText(text).entries()) {
    blocks.push(await makeBlock(document, chunk.text, [], { startOffset: chunk.start, endOffset: chunk.end }, `text-${index + 1}`));
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
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ",") { row.push(cell); cell = ""; continue; }
    if (char === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; continue; }
    cell += char;
  }
  row.push(cell.replace(/\r$/, ""));
  if (row.some((value) => value.length) || !rows.length) rows.push(row);
  return rows;
}

async function ingestCsv(document: SourceDocumentRecord, text: string): Promise<DocumentBlockRecord[]> {
  const rows = parseCsvRows(text);
  if (rows.length > MAX_CSV_ROWS + 1) throw new Error(`CSV exceeds the ${MAX_CSV_ROWS.toLocaleString()} row safety limit.`);
  const headers = rows[0].map((header, index) => header.trim() || `column_${index + 1}`);
  const blocks: DocumentBlockRecord[] = [];
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row.some((cell) => cell.trim())) continue;
    const pairs = headers.map((header, index) => `${header}: ${row[index] ?? ""}`);
    const textBlock = pairs.join("\n");
    blocks.push(await makeBlock(document, textBlock, ["CSV row"], { row: rowIndex + 1, columns: headers }, `row-${rowIndex + 1}`));
  }
  return blocks;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/?(?:p|div|section|article|main|aside|header|footer|li|tr|h[1-6]|br)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

async function ingestHtml(document: SourceDocumentRecord, html: string): Promise<DocumentBlockRecord[]> {
  if (typeof DOMParser === "undefined") return ingestPlain(document, stripHtml(html));
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("script,style,iframe,object,embed").forEach((node) => node.remove());
  const sections = [...parsed.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,td,th")]
    .map((node) => ({ tag: node.tagName.toLowerCase(), text: normalizeText(node.textContent ?? "") }))
    .filter((item) => item.text);
  const headingPath: string[] = [];
  const blocks: DocumentBlockRecord[] = [];
  let section = 0;
  for (const item of sections) {
    const heading = item.tag.match(/^h([1-6])$/);
    if (heading) {
      const level = Number(heading[1]);
      headingPath.splice(level - 1);
      headingPath[level - 1] = item.text;
      continue;
    }
    section += 1;
    blocks.push(await makeBlock(document, item.text, headingPath.filter(Boolean), { section: `html-${section}` }, `html-${section}`));
  }
  return blocks.length ? blocks : ingestPlain(document, parsed.body.textContent ?? "");
}

async function ingestPdf(document: SourceDocumentRecord, bytes: Uint8Array): Promise<DocumentBlockRecord[]> {
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
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = normalizeText((content.items as { str?: string }[]).map((item) => item.str ?? "").join(" "));
    for (const [index, chunk] of splitText(text).entries()) {
      blocks.push(await makeBlock(document, chunk.text, [`Page ${pageNumber}`], { page: pageNumber, startOffset: chunk.start, endOffset: chunk.end }, `page-${pageNumber}-${index + 1}`));
    }
    page.cleanup();
  }
  await task.destroy();
  return blocks;
}

async function ingestDocx(document: SourceDocumentRecord, buffer: ArrayBuffer): Promise<DocumentBlockRecord[]> {
  const mammoth = await import("mammoth/mammoth.browser");
  const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
  return ingestHtml(document, result.value);
}

export async function ingestBytes(name: string, mimeType: string, buffer: ArrayBuffer): Promise<DocumentImportBundle> {
  if (buffer.byteLength > MAX_DOCUMENT_BYTES) throw new Error(`Document exceeds the ${Math.floor(MAX_DOCUMENT_BYTES / 1024 / 1024)} MiB safety limit.`);
  const format = detectFormat(name, mimeType);
  if (!format) throw new Error(`Unsupported document type: ${name}`);
  const bytes = new Uint8Array(buffer);
  const document = await documentRecord(name, mimeType, bytes, format);
  const warnings: string[] = [];
  let blocks: DocumentBlockRecord[];
  if (format === "pdf") blocks = await ingestPdf(document, bytes);
  else if (format === "docx") blocks = await ingestDocx(document, buffer);
  else {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    if (format === "csv") blocks = await ingestCsv(document, text);
    else if (format === "html") blocks = await ingestHtml(document, text);
    else blocks = await ingestPlain(document, text);
  }
  if (!blocks.length) warnings.push("No indexable text was extracted from this document.");
  return { document, blocks, warnings };
}

export async function ingestFile(file: File): Promise<DocumentImportBundle> {
  return ingestBytes(file.name, file.type || "application/octet-stream", await file.arrayBuffer());
}

export function formatLocation(location: SourceLocation): string {
  const parts: string[] = [];
  if (location.page) parts.push(`page ${location.page}`);
  if (location.row) parts.push(`row ${location.row}`);
  if (location.section) parts.push(location.section);
  if (location.startOffset !== undefined && location.endOffset !== undefined) parts.push(`chars ${location.startOffset}–${location.endOffset}`);
  return parts.join(" · ") || "document block";
}
