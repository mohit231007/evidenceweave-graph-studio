import { expect, test, type Page } from "@playwright/test";

const navButton = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Primary views" }).getByRole("button", { name, exact: true });

function minimalPdf(text: string): Buffer {
  const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${escaped}) Tj\nET\n`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += object;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(entries: { name: string; data: string }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function minimalDocx(): Buffer {
  return zipStore([
    {
      name: "[Content_Types].xml",
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    },
    {
      name: "_rels/.rels",
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    },
    {
      name: "word/document.xml",
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>EvidenceWeave DOCX provenance proof</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table cell evidence</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>'
    }
  ]);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("EvidenceWeave", { exact: true })).toBeVisible();
});

test("note authoring, daily notes, trash and recovery survive the studio workflow", async ({ page }) => {
  await page.getByRole("button", { name: "+ New note", exact: true }).click();
  const editor = page.getByLabel("Markdown editor");
  await expect(editor).toBeVisible();
  await editor.fill("# Browser Smoke\n\nEvidenceWeave keeps local evidence and [[GraphRAG]].");
  await page.getByRole("button", { name: "Daily", exact: true }).click();
  await expect(page.locator(".document-header h1")).toContainText("Daily ");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  await navButton(page, "Library").click();
  await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByText(/Daily \d{4}-\d{2}-\d{2}/).first()).toBeVisible();
});

test("imports structured evidence in a worker, audits review, reopens decisions, edits validity, and produces a persisted routed trace", async ({ page }) => {
  const input = page.locator('aside.sidebar input[type="file"]').first();
  await input.setInputFiles({
    name: "acquisition.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Microsoft acquired GitHub in 2018. EvidenceWeave keeps provenance for every reviewed relationship.")
  });
  await navButton(page, "Documents").click();
  await expect(page.getByText("acquisition.txt", { exact: true })).toBeVisible();

  await navButton(page, "Review").click();
  await page.getByRole("button", { name: "Rebuild deterministic", exact: true }).click();
  await expect(page.getByText("Inference proposes. You decide.", { exact: true })).toBeVisible();
  const entitySection = page.locator(".review-columns > section").first();
  const relationSection = page.locator(".review-columns > section").nth(1);
  const firstAccept = entitySection.getByRole("button", { name: "Accept", exact: true }).first();
  await expect(firstAccept).toBeVisible();
  await firstAccept.click();
  const relationAccept = relationSection.getByRole("button", { name: "Accept", exact: true }).first();
  await expect(relationAccept).toBeVisible();
  await relationAccept.click();

  await page.getByRole("button", { name: "Reviewed", exact: true }).click();
  await expect(entitySection.locator(".review-card").first()).toContainText("accepted");
  await expect(page.locator(".audit-row").first()).toContainText(/accept/);
  await expect(entitySection.getByRole("button", { name: "Reopen", exact: true }).first()).toBeVisible();

  const relationCard = relationSection.locator(".review-card").first();
  const validityAnswers = ["2018-01-01", "2020-12-31"];
  page.on("dialog", async (dialog) => {
    if (dialog.type() === "prompt") await dialog.accept(validityAnswers.shift() ?? "");
  });
  await relationCard.getByRole("button", { name: "Edit validity", exact: true }).click();
  page.removeAllListeners("dialog");
  await expect(relationCard).toContainText("validity 2018-01-01 → 2020-12-31");
  await relationCard.getByRole("button", { name: "Reopen", exact: true }).click();
  await page.getByRole("button", { name: "Pending", exact: true }).click();
  await expect(relationSection.locator(".review-card").first()).toContainText("pending");

  await page.getByRole("button", { name: "Reviewed", exact: true }).click();
  const undo = page.locator(".audit-row").filter({ hasText: "accept" }).first().getByRole("button", { name: "Undo", exact: true });
  if (await undo.isVisible()) {
    await undo.click();
    await expect(page.locator(".audit-row").first()).toContainText("undo");
  }

  await navButton(page, "Evidence").click();
  await page.getByLabel("Evidence question").fill("What evidence supports provenance?");
  await page.getByRole("button", { name: "Retrieve", exact: true }).click();
  await expect(page.getByText(/evidence answer/i)).toBeVisible();
  await expect(page.locator(".trace-proof")).toBeVisible();
  await expect(page.locator(".trace-proof")).toContainText("Route:");
  await expect(page.getByRole("button", { name: "Download trace", exact: true })).toBeVisible();

  await navButton(page, "Library").click();
  await expect(page.locator(".trace-list-row")).toHaveCount(1);
});

test("PDF import preserves page-level browser provenance", async ({ page }) => {
  const input = page.locator('aside.sidebar input[type="file"]').first();
  await input.setInputFiles({
    name: "browser-proof.pdf",
    mimeType: "application/pdf",
    buffer: minimalPdf("EvidenceWeave PDF provenance proof")
  });
  await navButton(page, "Documents").click();
  const card = page.locator(".document-card").filter({ hasText: "browser-proof.pdf" });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.locator(".source-mini").first()).toContainText("page 1");
  await expect(card.locator(".source-mini").first()).toContainText("EvidenceWeave PDF provenance proof");
});

test("DOCX import preserves paragraph and table evidence in-browser", async ({ page }) => {
  const input = page.locator('aside.sidebar input[type="file"]').first();
  await input.setInputFiles({
    name: "browser-proof.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: minimalDocx()
  });
  await navButton(page, "Documents").click();
  const card = page.locator(".document-card").filter({ hasText: "browser-proof.docx" });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText("EvidenceWeave DOCX provenance proof");
  await expect(card).toContainText("Table cell evidence");
});

test("unsupported document input fails closed without creating a source record", async ({ page }) => {
  const input = page.locator('aside.sidebar input[type="file"]').first();
  await input.setInputFiles({ name: "unsafe.exe", mimeType: "application/octet-stream", buffer: Buffer.from([0, 1, 2, 3]) });
  await expect(page.locator(".statusbar")).toContainText("1 failed");
  await navButton(page, "Documents").click();
  await expect(page.getByText("unsafe.exe", { exact: true })).toHaveCount(0);
});

test("cancelled worker import commits no partial state and can be resumed", async ({ page }) => {
  test.setTimeout(60_000);
  const input = page.locator('aside.sidebar input[type="file"]').first();
  const rows = ["id,name", ...Array.from({ length: 3000 }, (_, index) => `${index + 1},Person ${index + 1}`)].join("\n");
  await input.setInputFiles({ name: "resumable.csv", mimeType: "text/csv", buffer: Buffer.from(rows) });
  await navButton(page, "Documents").click();
  const cancel = page.getByRole("button", { name: "Cancel import", exact: true });
  await expect(cancel).toBeVisible({ timeout: 10_000 });
  await cancel.click();
  await expect(page.getByRole("button", { name: "Resume import", exact: true })).toBeVisible();
  await expect(page.getByText("resumable.csv", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Resume import", exact: true }).click();
  await expect(page.locator(".document-card").filter({ hasText: "resumable.csv" })).toBeVisible({ timeout: 45_000 });
});

test("canvas supports note, document, label, edges and grouping and graph renders without a backend", async ({ page }) => {
  const input = page.locator('aside.sidebar input[type="file"]').first();
  await input.setInputFiles({ name: "canvas-source.txt", mimeType: "text/plain", buffer: Buffer.from("Canvas document evidence") });
  await expect(page.locator(".statusbar")).toContainText("Imported 1 document");

  await navButton(page, "Canvas").click();
  await page.getByRole("button", { name: "New canvas", exact: true }).click();
  await page.getByRole("button", { name: "Add current note", exact: true }).click();
  await page.getByRole("button", { name: "Add latest document", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept("Evidence cluster"));
  await page.getByRole("button", { name: "Add label", exact: true }).click();
  await expect(page.locator(".canvas-node:not(.canvas-group)")).toHaveCount(3);
  await expect(page.locator(".canvas-node").filter({ hasText: "canvas-source.txt" })).toContainText("document · linked");
  await page.getByRole("button", { name: "Connect last two", exact: true }).click();
  await expect(page.locator(".canvas-edge-label")).toHaveCount(1);
  page.once("dialog", (dialog) => dialog.accept("Research"));
  await page.getByRole("button", { name: "Group", exact: true }).click();
  await expect(page.locator(".canvas-group")).toHaveCount(1);
  await navButton(page, "Graph").click();
  await expect(page.locator(".graph-canvas")).toBeVisible();
});

test("trashing and restoring a note removes and restores its Canvas placement and edges", async ({ page }) => {
  await navButton(page, "Canvas").click();
  await page.getByRole("button", { name: "New canvas", exact: true }).click();
  await page.getByRole("button", { name: "Add current note", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept("Connected label"));
  await page.getByRole("button", { name: "Add label", exact: true }).click();
  await page.getByRole("button", { name: "Connect last two", exact: true }).click();
  await expect(page.locator(".canvas-node:not(.canvas-group)")).toHaveCount(2);
  await expect(page.locator(".canvas-edge-label")).toHaveCount(1);

  await navButton(page, "Workspace").click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  await navButton(page, "Canvas").click();
  await expect(page.locator(".canvas-node:not(.canvas-group)")).toHaveCount(1);
  await expect(page.locator(".canvas-edge-label")).toHaveCount(0);

  await navButton(page, "Library").click();
  await page.getByRole("button", { name: "Restore", exact: true }).first().click();
  await navButton(page, "Canvas").click();
  await expect(page.locator(".canvas-node:not(.canvas-group)")).toHaveCount(2);
  await expect(page.locator(".canvas-edge-label")).toHaveCount(1);
});

test("saved Kanban views and note snapshots remain local and recoverable", async ({ page }) => {
  await page.getByRole("button", { name: "Create snapshot", exact: true }).click();
  await expect(page.locator(".statusbar")).toContainText("Created local recovery snapshot");

  await page.getByRole("button", { name: "+ New note", exact: true }).click();
  await page.getByLabel("Markdown editor").fill("---\nstatus: testing\n---\n# Temporary Browser Note\n\nThis note should disappear when the snapshot is restored.");

  await navButton(page, "Library").click();
  const promptAnswers = ["Release board", "status"];
  page.on("dialog", async (dialog) => {
    if (dialog.type() === "prompt") await dialog.accept(promptAnswers.shift() ?? "");
  });
  await page.getByRole("button", { name: "+ Kanban", exact: true }).click();
  await expect(page.locator(".saved-view-display.mode-kanban")).toBeVisible();
  await expect(page.getByRole("button", { name: "Release board", exact: true })).toBeVisible();

  page.removeAllListeners("dialog");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Restore snapshot", exact: true }).click();
  await expect(page.getByText("Temporary Browser Note", { exact: true })).toHaveCount(0);
});

test("calendar, user templates and recent workspace state survive a browser reload", async ({ page }) => {
  await page.getByLabel("Daily note date").fill("2026-12-31");
  await page.getByRole("button", { name: "Create daily note", exact: true }).click();
  await expect(page.locator(".document-header h1")).toHaveText("Daily 2026-12-31");
  await page.getByRole("button", { name: "Next day", exact: true }).click();
  await expect(page.getByLabel("Daily note date")).toHaveValue("2027-01-01");
  await page.getByRole("button", { name: "Create daily note", exact: true }).click();
  await expect(page.locator(".document-header h1")).toHaveText("Daily 2027-01-01");

  const promptAnswers = ["Research template", "---\ntype: research\n---\n# {{title}}\n\n## Evidence\n"];
  page.on("dialog", async (dialog) => {
    if (dialog.type() === "prompt") await dialog.accept(promptAnswers.shift() ?? "");
  });
  await page.getByRole("button", { name: "New template", exact: true }).click();
  await expect(page.getByLabel("Daily note template")).toContainText("Research template");
  page.removeAllListeners("dialog");

  await navButton(page, "Library").click();
  await expect(page.getByText("Structured, recoverable, portable.", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Structured, recoverable, portable.", { exact: true })).toBeVisible();
  await navButton(page, "Workspace").click();
  await expect(page.locator(".document-header h1")).toHaveText("Daily 2027-01-01");
  await expect(page.getByLabel("Daily note template")).toContainText("Research template");
  await expect(page.locator(".workspace-tools")).toContainText("Daily 2027-01-01");
});
