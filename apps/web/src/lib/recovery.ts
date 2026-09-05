import { db, type NoteRecord } from "./core";
import { knowledgeDb, type CanvasEdgeRecord, type CanvasNodeRecord, type SnapshotRecord, type TrashRecord } from "./store";
import { loadWorkspaceState, removeNoteFromWorkspaceState, touchRecentNote } from "./workspace-state";

interface TrashedCanvasPlacement {
  canvasId: string;
  nodes: CanvasNodeRecord[];
  edges: CanvasEdgeRecord[];
}

interface NoteTrashEnvelopeV2 {
  version: 2;
  note: NoteRecord;
  canvasPlacements: TrashedCanvasPlacement[];
}

function parseTrashedNote(payload: string): NoteTrashEnvelopeV2 {
  const parsed = JSON.parse(payload) as NoteRecord | NoteTrashEnvelopeV2;
  if ((parsed as NoteTrashEnvelopeV2).version === 2 && (parsed as NoteTrashEnvelopeV2).note) return parsed as NoteTrashEnvelopeV2;
  return { version: 2, note: parsed as NoteRecord, canvasPlacements: [] };
}

export async function moveNoteToTrash(note: NoteRecord): Promise<void> {
  const canvases = await knowledgeDb.canvases.toArray();
  const placements: TrashedCanvasPlacement[] = [];
  const nextCanvases = canvases.map((canvas) => {
    const nodes = canvas.nodes.filter((node) => node.kind === "note" && node.refId === note.id);
    if (!nodes.length) return canvas;
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = canvas.edges.filter((edge) => nodeIds.has(edge.source) || nodeIds.has(edge.target));
    placements.push({ canvasId: canvas.id, nodes, edges });
    return {
      ...canvas,
      nodes: canvas.nodes.filter((node) => !nodeIds.has(node.id)),
      edges: canvas.edges.filter((edge) => !nodeIds.has(edge.source) && !nodeIds.has(edge.target)),
      updatedAt: new Date().toISOString()
    };
  });
  const envelope: NoteTrashEnvelopeV2 = { version: 2, note, canvasPlacements: placements };
  const record: TrashRecord = { id: `note:${note.id}`, kind: "note", payload: JSON.stringify(envelope), deletedAt: new Date().toISOString() };
  const workspaceState = removeNoteFromWorkspaceState(await loadWorkspaceState(), note.id);

  await knowledgeDb.transaction("rw", [knowledgeDb.trash, knowledgeDb.canvases, knowledgeDb.workspaceState], async () => {
    await knowledgeDb.trash.put(record);
    if (nextCanvases.length) await knowledgeDb.canvases.bulkPut(nextCanvases);
    await knowledgeDb.workspaceState.put(workspaceState);
  });
  await db.notes.delete(note.id);
}

export async function restoreTrashedNote(trashId: string): Promise<NoteRecord> {
  const record = await knowledgeDb.trash.get(trashId);
  if (!record || record.kind !== "note") throw new Error("Trashed note was not found.");
  const envelope = parseTrashedNote(record.payload);
  const note = envelope.note;
  await db.notes.put(note);

  const workspaceState = touchRecentNote(await loadWorkspaceState(), note.id);
  await knowledgeDb.transaction("rw", [knowledgeDb.trash, knowledgeDb.canvases, knowledgeDb.workspaceState], async () => {
    for (const placement of envelope.canvasPlacements) {
      const canvas = await knowledgeDb.canvases.get(placement.canvasId);
      if (!canvas) continue;
      const existingNodeIds = new Set(canvas.nodes.map((node) => node.id));
      const nodes = [...canvas.nodes, ...placement.nodes.filter((node) => !existingNodeIds.has(node.id))];
      const allNodeIds = new Set(nodes.map((node) => node.id));
      const existingEdgeIds = new Set(canvas.edges.map((edge) => edge.id));
      const edges = [
        ...canvas.edges,
        ...placement.edges.filter((edge) => !existingEdgeIds.has(edge.id) && allNodeIds.has(edge.source) && allNodeIds.has(edge.target))
      ];
      await knowledgeDb.canvases.put({ ...canvas, nodes, edges, updatedAt: new Date().toISOString() });
    }
    await knowledgeDb.workspaceState.put(workspaceState);
    await knowledgeDb.trash.delete(trashId);
  });
  return note;
}

export async function createNotesSnapshot(label: string, notes: NoteRecord[]): Promise<SnapshotRecord> {
  const record: SnapshotRecord = { id: crypto.randomUUID(), label, payload: JSON.stringify(notes), createdAt: new Date().toISOString() };
  await knowledgeDb.snapshots.put(record);
  return record;
}

export async function restoreNotesSnapshot(snapshotId: string): Promise<NoteRecord[]> {
  const snapshot = await knowledgeDb.snapshots.get(snapshotId);
  if (!snapshot) throw new Error("Snapshot was not found.");
  const notes = JSON.parse(snapshot.payload) as NoteRecord[];
  await db.transaction("rw", db.notes, async () => { await db.notes.clear(); await db.notes.bulkPut(notes); });
  const state = await loadWorkspaceState();
  const live = new Set(notes.map((note) => note.id));
  await knowledgeDb.workspaceState.put({
    ...state,
    activeNoteId: state.activeNoteId && live.has(state.activeNoteId) ? state.activeNoteId : notes[0]?.id,
    openNoteIds: state.openNoteIds.filter((id) => live.has(id)),
    recentNoteIds: state.recentNoteIds.filter((id) => live.has(id)),
    updatedAt: new Date().toISOString()
  });
  return notes;
}
