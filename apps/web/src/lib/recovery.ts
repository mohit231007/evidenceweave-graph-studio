import { db, type NoteRecord } from "./core";
import { knowledgeDb, type SnapshotRecord, type TrashRecord } from "./store";

export async function moveNoteToTrash(note: NoteRecord): Promise<void> {
  const record: TrashRecord = { id: `note:${note.id}`, kind: "note", payload: JSON.stringify(note), deletedAt: new Date().toISOString() };
  await knowledgeDb.transaction("rw", knowledgeDb.trash, async () => { await knowledgeDb.trash.put(record); });
  await db.notes.delete(note.id);
}

export async function restoreTrashedNote(trashId: string): Promise<NoteRecord> {
  const record = await knowledgeDb.trash.get(trashId);
  if (!record || record.kind !== "note") throw new Error("Trashed note was not found.");
  const note = JSON.parse(record.payload) as NoteRecord;
  await db.notes.put(note);
  await knowledgeDb.trash.delete(trashId);
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
  return notes;
}
