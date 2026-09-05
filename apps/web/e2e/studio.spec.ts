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

test("imports structured evidence in a worker, audits review, and produces a persisted routed trace", async ({ page }) => {
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
  const firstAccept = page.getByRole("button", { name: "Accept", exact: true }).first();
  await expect(firstAccept).toBeVisible();
  await firstAccept.click();
  await page.getByRole("button", { name: "Reviewed", exact: true }).click();
  await expect(page.locator(".review-card").first()).toContainText("accepted");
  await expect(page.locator(".audit-row").first()).toContainText("accept");
  const undo = page.locator(".audit-row").first().getByRole("button", { name: "Undo", exact: true });
  await expect(undo).toBeVisible();
  await undo.click();
  await expect(page.locator(".audit-row").first()).toContainText("undo");
  await page.getByRole("button", { name: "Pending", exact: true }).click();
  await expect(page.locator(".review-card").first()).toContainText("pending");

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

test("unsupported document input fails closed without creating a source record", async ({ page }) => {
  const input = page.locator('aside.sidebar input[type="file"]').first();
  await input.setInputFiles({ name: "unsafe.exe", mimeType: "application/octet-stream", buffer: Buffer.from([0, 1, 2, 3]) });
  await expect(page.locator(".statusbar")).toContainText("1 failed");
  await navButton(page, "Documents").click();
  await expect(page.getByText("unsafe.exe", { exact: true })).toHaveCount(0);
});

test("canvas supports labels, edges and grouping and graph renders without a backend", async ({ page }) => {
  await navButton(page, "Canvas").click();
  await page.getByRole("button", { name: "New canvas", exact: true }).click();
  await page.getByRole("button", { name: "Add current note", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept("Evidence cluster"));
  await page.getByRole("button", { name: "Add label", exact: true }).click();
  await expect(page.locator(".canvas-node:not(.canvas-group)")).toHaveCount(2);
  await page.getByRole("button", { name: "Connect last two", exact: true }).click();
  await expect(page.locator(".canvas-edge-label")).toHaveCount(1);
  page.once("dialog", (dialog) => dialog.accept("Research"));
  await page.getByRole("button", { name: "Group", exact: true }).click();
  await expect(page.locator(".canvas-group")).toHaveCount(1);
  await navButton(page, "Graph").click();
  await expect(page.locator(".graph-canvas")).toBeVisible();
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
  await page.getByLabel("Daily note date").fill("2026-09-06");
  await page.getByRole("button", { name: "Create daily note", exact: true }).click();
  await expect(page.locator(".document-header h1")).toHaveText("Daily 2026-09-06");

  const promptAnswers = ["Research template", "---\ntype: research\n---\n# {{title}}\n\n## Evidence\n"];
  page.on("dialog", async (dialog) => {
    if (dialog.type() === "prompt") await dialog.accept(promptAnswers.shift() ?? "");
  });
  await page.getByRole("button", { name: "New template", exact: true }).click();
  await expect(page.getByLabel("Daily note template")).toContainText("Research template");
  page.removeAllListeners("dialog");

  await page.reload();
  await expect(page.locator(".document-header h1")).toHaveText("Daily 2026-09-06");
  await expect(page.getByLabel("Daily note template")).toContainText("Research template");
  await expect(page.locator(".workspace-tools")).toContainText("Daily 2026-09-06");
});
