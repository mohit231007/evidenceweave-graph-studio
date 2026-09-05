import type { CanvasRecord, CanvasNodeRecord, SavedViewRecord } from "./store";
import type { NoteRecord } from "./core";

export const CANVAS_FORMAT_VERSION = "evidenceweave-canvas-v1";

export function createCanvas(title = "Knowledge Canvas"): CanvasRecord {
  const stamp = new Date().toISOString();
  return { id: crypto.randomUUID(), title, nodes: [], edges: [], createdAt: stamp, updatedAt: stamp };
}

export function addCanvasNode(canvas: CanvasRecord, node: Omit<CanvasNodeRecord, "id">): CanvasRecord {
  return { ...canvas, nodes: [...canvas.nodes, { ...node, id: crypto.randomUUID() }], updatedAt: new Date().toISOString() };
}

export function moveCanvasNode(canvas: CanvasRecord, nodeId: string, x: number, y: number): CanvasRecord {
  return { ...canvas, nodes: canvas.nodes.map((node) => node.id === nodeId ? { ...node, x, y } : node), updatedAt: new Date().toISOString() };
}

export function exportCanvas(canvas: CanvasRecord): string {
  return JSON.stringify({ format: CANVAS_FORMAT_VERSION, canvas }, null, 2);
}

export function importCanvas(raw: string): CanvasRecord {
  const parsed = JSON.parse(raw) as { format?: string; canvas?: CanvasRecord };
  if (parsed.format !== CANVAS_FORMAT_VERSION || !parsed.canvas || !Array.isArray(parsed.canvas.nodes) || !Array.isArray(parsed.canvas.edges)) throw new Error("Unsupported or malformed EvidenceWeave canvas.");
  return parsed.canvas;
}

export function dailyNoteTitle(date: Date, prefix = "Daily"): string {
  const local = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
  const year = local.getFullYear();
  const month = String(local.getMonth() + 1).padStart(2, "0");
  const day = String(local.getDate()).padStart(2, "0");
  return `${prefix} ${year}-${month}-${day}`;
}

export function expandTemplate(template: string, date = new Date(), variables: Record<string, string> = {}): string {
  const dateValue = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const timeValue = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const values: Record<string, string> = { date: dateValue, time: timeValue, ...variables };
  return template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (match, key: string) => values[key] ?? match);
}

export function applySavedView(notes: NoteRecord[], view: SavedViewRecord): NoteRecord[] {
  return notes.filter((note) => view.filters.every((filter) => {
    const frontmatter = note.markdown.match(/^---\s*\n([\s\S]*?)\n---/);
    const propertyLine = frontmatter?.[1].split(/\r?\n/).find((line) => line.toLocaleLowerCase().startsWith(`${filter.property.toLocaleLowerCase()}:`));
    const value = propertyLine?.slice(propertyLine.indexOf(":") + 1).trim() ?? "";
    if (filter.operator === "exists") return Boolean(propertyLine);
    if (filter.operator === "equals") return value.toLocaleLowerCase() === (filter.value ?? "").toLocaleLowerCase();
    return value.toLocaleLowerCase().includes((filter.value ?? "").toLocaleLowerCase());
  }));
}
