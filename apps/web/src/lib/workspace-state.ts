import type { NoteRecord } from "./core";
import { knowledgeDb, type MigrationRecord, type SnapshotRecord, type TemplateRecord, type WorkspaceStateRecord } from "./store";
import { dailyNoteTitle, expandTemplate } from "./workspace";

export const WORKSPACE_SCHEMA_VERSION = 3;
export const DEFAULT_DAILY_TEMPLATE = "---\ntype: daily\ndate: {{date}}\nstatus: open\n---\n# {{title}}\n\n## Focus\n\n## Notes\n\n## Evidence captured\n";

export function emptyWorkspaceState(): WorkspaceStateRecord {
  return {
    id: "default",
    activeView: "workspace",
    openNoteIds: [],
    recentNoteIds: [],
    updatedAt: new Date().toISOString()
  };
}

export async function loadWorkspaceState(): Promise<WorkspaceStateRecord> {
  return (await knowledgeDb.workspaceState.get("default")) ?? emptyWorkspaceState();
}

export async function saveWorkspaceState(patch: Partial<Omit<WorkspaceStateRecord, "id">>): Promise<WorkspaceStateRecord> {
  const current = await loadWorkspaceState();
  const next: WorkspaceStateRecord = { ...current, ...patch, id: "default", updatedAt: new Date().toISOString() };
  await knowledgeDb.workspaceState.put(next);
  return next;
}

export function touchRecentNote(state: WorkspaceStateRecord, noteId: string, limit = 20): WorkspaceStateRecord {
  const openNoteIds = [...new Set([...state.openNoteIds, noteId])].slice(-12);
  const recentNoteIds = [noteId, ...state.recentNoteIds.filter((id) => id !== noteId)].slice(0, Math.max(1, limit));
  return { ...state, activeNoteId: noteId, openNoteIds, recentNoteIds, updatedAt: new Date().toISOString() };
}

export function removeNoteFromWorkspaceState(state: WorkspaceStateRecord, noteId: string): WorkspaceStateRecord {
  const openNoteIds = state.openNoteIds.filter((id) => id !== noteId);
  const recentNoteIds = state.recentNoteIds.filter((id) => id !== noteId);
  return {
    ...state,
    activeNoteId: state.activeNoteId === noteId ? openNoteIds.at(-1) : state.activeNoteId,
    openNoteIds,
    recentNoteIds,
    updatedAt: new Date().toISOString()
  };
}

export function parseDailyTitle(title: string, prefix = "Daily"): Date | undefined {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = title.match(new RegExp(`^${escaped}\\s+(\\d{4})-(\\d{2})-(\\d{2})$`));
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 12);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return undefined;
  return date;
}

export function shiftCalendarDate(date: Date, days: number): Date {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
  next.setDate(next.getDate() + days);
  return next;
}

export function dailyCalendar(notes: NoteRecord[], prefix = "Daily"): { date: Date; note: NoteRecord }[] {
  return notes.flatMap((note) => {
    const date = parseDailyTitle(note.title, prefix);
    return date ? [{ date, note }] : [];
  }).sort((left, right) => left.date.getTime() - right.date.getTime());
}

export function dailyTemplateBody(template: TemplateRecord | undefined, date: Date, title = dailyNoteTitle(date)): string {
  return expandTemplate(template?.body ?? DEFAULT_DAILY_TEMPLATE, date, { title });
}

export async function createTemplate(title: string, body: string): Promise<TemplateRecord> {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) throw new Error("Template title cannot be empty.");
  if (!body.trim()) throw new Error("Template body cannot be empty.");
  const now = new Date().toISOString();
  const record: TemplateRecord = { id: crypto.randomUUID(), title: trimmedTitle, body, createdAt: now, updatedAt: now };
  await knowledgeDb.templates.add(record);
  return record;
}

export async function updateTemplate(template: TemplateRecord, patch: Partial<Pick<TemplateRecord, "title" | "body">>): Promise<TemplateRecord> {
  const next = { ...template, ...patch, title: (patch.title ?? template.title).trim(), updatedAt: new Date().toISOString() };
  if (!next.title || !next.body.trim()) throw new Error("Template title and body are required.");
  await knowledgeDb.templates.put(next);
  return next;
}

export async function deleteTemplate(id: string): Promise<void> {
  await knowledgeDb.templates.delete(id);
}

export async function recordMigration(fromVersion: number, toVersion: number, recoverySnapshotId?: string): Promise<MigrationRecord> {
  if (toVersion <= fromVersion) throw new Error("Migration target must be newer than its source version.");
  const record: MigrationRecord = {
    id: `${fromVersion}->${toVersion}`,
    fromVersion,
    toVersion,
    recoverySnapshotId,
    appliedAt: new Date().toISOString()
  };
  await knowledgeDb.migrations.put(record);
  return record;
}

export async function ensureWorkspaceSchema(notes: NoteRecord[]): Promise<MigrationRecord> {
  const existing = await knowledgeDb.migrations.orderBy("toVersion").last();
  if (existing && existing.toVersion >= WORKSPACE_SCHEMA_VERSION) return existing;

  const legacyCounts = await Promise.all([
    knowledgeDb.documents.count(),
    knowledgeDb.blocks.count(),
    knowledgeDb.entities.count(),
    knowledgeDb.relations.count(),
    knowledgeDb.canvases.count(),
    knowledgeDb.views.count(),
    knowledgeDb.trash.count(),
    knowledgeDb.snapshots.count(),
    knowledgeDb.reviewAudit.count(),
    knowledgeDb.queryTraces.count()
  ]);
  const hasLegacyKnowledge = legacyCounts.some((count) => count > 0);
  let recoverySnapshotId: string | undefined;

  if (hasLegacyKnowledge && notes.length) {
    const snapshot: SnapshotRecord = {
      id: crypto.randomUUID(),
      label: `Automatic pre-v${WORKSPACE_SCHEMA_VERSION} migration recovery`,
      payload: JSON.stringify(notes),
      createdAt: new Date().toISOString()
    };
    await knowledgeDb.snapshots.put(snapshot);
    recoverySnapshotId = snapshot.id;
  }

  return recordMigration(hasLegacyKnowledge ? 2 : 0, WORKSPACE_SCHEMA_VERSION, recoverySnapshotId);
}
