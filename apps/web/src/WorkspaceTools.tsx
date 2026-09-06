import { useEffect, useMemo, useState } from "react";
import type { NoteRecord } from "./lib/core";
import { knowledgeDb, type TemplateRecord, type WorkspaceStateRecord } from "./lib/store";
import {
  createTemplate,
  dailyCalendar,
  dailyTemplateBody,
  deleteTemplate,
  emptyWorkspaceState,
  loadWorkspaceState,
  parseDailyTitle,
  shiftCalendarDate
} from "./lib/workspace-state";
import { dailyNoteTitle } from "./lib/workspace";

const isoDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const parseDateInput = (value: string) => {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return new Date();
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
};

export default function WorkspaceTools({ notes, createNote, openNote, onChanged }: {
  notes: NoteRecord[];
  createNote: (title?: string, markdown?: string) => Promise<void>;
  openNote: (id: string) => void;
  onChanged?: () => Promise<void> | void;
}) {
  const [date, setDate] = useState(() => new Date());
  const [templates, setTemplates] = useState<TemplateRecord[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [state, setState] = useState<WorkspaceStateRecord>(emptyWorkspaceState());
  const calendar = useMemo(() => dailyCalendar(notes), [notes]);

  const refresh = async () => {
    const [nextTemplates, nextState] = await Promise.all([
      knowledgeDb.templates.orderBy("updatedAt").reverse().toArray(),
      loadWorkspaceState()
    ]);
    setTemplates(nextTemplates);
    setState(nextState);
    if (templateId && !nextTemplates.some((template) => template.id === templateId)) setTemplateId("");
  };
  useEffect(() => { void refresh(); }, [notes.length]);

  const openDay = async () => {
    const title = dailyNoteTitle(date);
    const existing = notes.find((note) => note.title === title);
    if (existing) { openNote(existing.id); return; }
    const template = templates.find((item) => item.id === templateId);
    await createNote(title, dailyTemplateBody(template, date, title));
    await refresh();
  };

  const addTemplate = async () => {
    const title = prompt("Template name", "Research note")?.trim();
    if (!title) return;
    const body = prompt("Template body. Variables: {{title}}, {{date}}, {{time}}", "---\ntype: research\nstatus: active\n---\n# {{title}}\n\n## Question\n\n## Evidence\n\n## Connections\n") ?? "";
    if (!body.trim()) return;
    const record = await createTemplate(title, body);
    setTemplateId(record.id);
    await refresh();
    await onChanged?.();
  };

  const removeTemplate = async () => {
    if (!templateId) return;
    const template = templates.find((item) => item.id === templateId);
    if (!template || !confirm(`Delete local template “${template.title}”?`)) return;
    await deleteTemplate(template.id);
    setTemplateId("");
    await refresh();
    await onChanged?.();
  };

  const byId = new Map(notes.map((note) => [note.id, note]));
  const recent = state.recentNoteIds.map((id) => byId.get(id)).filter((note): note is NoteRecord => Boolean(note));
  const open = state.openNoteIds.map((id) => byId.get(id)).filter((note): note is NoteRecord => Boolean(note));
  const selectedDaily = calendar.find((item) => isoDate(item.date) === isoDate(date));

  return (
    <section className="workspace-tools panel">
      <div className="panel-title">Calendar & workspace</div>
      <div className="calendar-row">
        <button aria-label="Previous day" onClick={() => setDate((current) => shiftCalendarDate(current, -1))}>←</button>
        <input aria-label="Daily note date" type="date" value={isoDate(date)} onChange={(event) => setDate(parseDateInput(event.target.value))} />
        <button aria-label="Next day" onClick={() => setDate((current) => shiftCalendarDate(current, 1))}>→</button>
      </div>
      <button className="primary" onClick={() => void openDay()}>{selectedDaily ? "Open daily note" : "Create daily note"}</button>
      <small>{calendar.length} dated daily note{calendar.length === 1 ? "" : "s"} in this workspace.</small>

      <div className="panel-title">Templates</div>
      <select aria-label="Daily note template" value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
        <option value="">Built-in daily template</option>
        {templates.map((template) => <option key={template.id} value={template.id}>{template.title}</option>)}
      </select>
      <div className="review-actions"><button onClick={() => void addTemplate()}>New template</button><button disabled={!templateId} onClick={() => void removeTemplate()}>Delete</button></div>

      <div className="panel-title">Open tabs <span>{open.length}</span></div>
      <div className="compact-link-list">{open.slice(-8).map((note) => <button key={note.id} onClick={() => openNote(note.id)}>{note.title}</button>)}</div>
      <div className="panel-title">Recent <span>{recent.length}</span></div>
      <div className="compact-link-list">{recent.slice(0, 8).map((note) => <button key={note.id} onClick={() => openNote(note.id)}>{note.title}</button>)}</div>
      {state.activeNoteId && <small>Active note state is persisted locally.</small>}
      {parseDailyTitle(dailyNoteTitle(date)) && <small>Daily titles use local calendar dates, not UTC rollover.</small>}
    </section>
  );
}
