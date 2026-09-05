import { parseMarkdown, type NoteRecord } from "./core";
import type { CanvasEdgeRecord, CanvasNodeRecord, CanvasRecord, SavedViewRecord } from "./store";

export const CANVAS_FORMAT_VERSION = "evidenceweave-canvas-v2";

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

export function resizeCanvasNode(canvas: CanvasRecord, nodeId: string, width: number, height: number): CanvasRecord {
  return { ...canvas, nodes: canvas.nodes.map((node) => node.id === nodeId ? { ...node, width: Math.max(80, width), height: Math.max(50, height) } : node), updatedAt: new Date().toISOString() };
}

export function addCanvasEdge(canvas: CanvasRecord, source: string, target: string, label?: string): CanvasRecord {
  if (source === target) throw new Error("Canvas self-links are not supported.");
  if (!canvas.nodes.some((node) => node.id === source) || !canvas.nodes.some((node) => node.id === target)) throw new Error("Canvas edge endpoints must exist.");
  const duplicate = canvas.edges.some((edge) => edge.source === source && edge.target === target && (edge.label ?? "") === (label ?? ""));
  if (duplicate) return canvas;
  const edge: CanvasEdgeRecord = { id: crypto.randomUUID(), source, target, label: label?.trim() || undefined };
  return { ...canvas, edges: [...canvas.edges, edge], updatedAt: new Date().toISOString() };
}

export function removeCanvasNode(canvas: CanvasRecord, nodeId: string): CanvasRecord {
  return { ...canvas, nodes: canvas.nodes.filter((node) => node.id !== nodeId), edges: canvas.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId), updatedAt: new Date().toISOString() };
}

export function assignCanvasGroup(canvas: CanvasRecord, nodeIds: string[], label: string): CanvasRecord {
  const selected = canvas.nodes.filter((node) => nodeIds.includes(node.id) && node.kind !== "group");
  if (!selected.length) throw new Error("A canvas group needs at least one existing node.");
  const minX = Math.min(...selected.map((node) => node.x)) - 24;
  const minY = Math.min(...selected.map((node) => node.y)) - 44;
  const maxX = Math.max(...selected.map((node) => node.x + node.width)) + 24;
  const maxY = Math.max(...selected.map((node) => node.y + node.height)) + 24;
  const groupId = crypto.randomUUID();
  const group: CanvasNodeRecord = { id: groupId, kind: "group", label: label.trim() || "Group", x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  return { ...canvas, nodes: [group, ...canvas.nodes.map((node) => nodeIds.includes(node.id) ? { ...node, groupId } : node)], updatedAt: new Date().toISOString() };
}

export function exportCanvas(canvas: CanvasRecord): string {
  return JSON.stringify({ format: CANVAS_FORMAT_VERSION, canvas }, null, 2);
}

export function importCanvas(raw: string): CanvasRecord {
  const parsed = JSON.parse(raw) as { format?: string; canvas?: CanvasRecord };
  if (!["evidenceweave-canvas-v1", CANVAS_FORMAT_VERSION].includes(parsed.format ?? "") || !parsed.canvas || !Array.isArray(parsed.canvas.nodes) || !Array.isArray(parsed.canvas.edges)) throw new Error("Unsupported or malformed EvidenceWeave canvas.");
  const nodeIds = new Set(parsed.canvas.nodes.map((node) => node.id));
  if (parsed.canvas.edges.some((edge) => !nodeIds.has(edge.source) || !nodeIds.has(edge.target))) throw new Error("Canvas contains a dangling edge.");
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

export function createSavedView(title: string, mode: SavedViewRecord["mode"], groupBy?: string): SavedViewRecord {
  const stamp = new Date().toISOString();
  return { id: crypto.randomUUID(), title: title.trim() || "Untitled view", mode, groupBy: groupBy?.trim() || undefined, filters: [], createdAt: stamp, updatedAt: stamp };
}

export function applySavedView(notes: NoteRecord[], view: SavedViewRecord): NoteRecord[] {
  return notes.filter((note) => view.filters.every((filter) => {
    const properties = parseMarkdown(note.markdown).properties;
    const raw = properties[filter.property];
    const value = Array.isArray(raw) ? raw.join(", ") : raw === undefined ? "" : String(raw);
    if (filter.operator === "exists") return raw !== undefined;
    if (filter.operator === "equals") return value.toLocaleLowerCase() === (filter.value ?? "").toLocaleLowerCase();
    return value.toLocaleLowerCase().includes((filter.value ?? "").toLocaleLowerCase());
  }));
}

export function groupNotesForView(notes: NoteRecord[], view: SavedViewRecord): Map<string, NoteRecord[]> {
  const filtered = applySavedView(notes, view);
  const groups = new Map<string, NoteRecord[]>();
  if (!view.groupBy) { groups.set("All", filtered); return groups; }
  for (const note of filtered) {
    const property = parseMarkdown(note.markdown).properties[view.groupBy];
    const keys = Array.isArray(property) ? property.map(String) : [property === undefined ? "Unspecified" : String(property)];
    for (const key of keys) groups.set(key, [...(groups.get(key) ?? []), note]);
  }
  return new Map([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)));
}
