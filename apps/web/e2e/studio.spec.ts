import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("EvidenceWeave", { exact: true })).toBeVisible();
});

test("note authoring, daily notes, trash and recovery survive the studio workflow", async ({ page }) => {
  await page.getByRole("button", { name: "+ New note" }).click();
  const editor = page.getByLabel("Markdown editor");
  await expect(editor).toBeVisible();
  await editor.fill("# Browser Smoke\n\nEvidenceWeave keeps local evidence and [[GraphRAG]].");
  await page.getByRole("button", { name: "Daily" }).click();
  await expect(page.locator(".document-header h1")).toContainText("Daily ");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Trash" }).click();
  await page.getByRole("button", { name: "Library" }).click();
  await expect(page.getByRole("button", { name: "Restore" })).toBeVisible();
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText(/Daily \d{4}-\d{2}-\d{2}/).first()).toBeVisible();
});

test("imports structured evidence and exposes review and retrieval surfaces", async ({ page }) => {
  const input = page.locator('aside.sidebar input[type="file"]').first();
  await input.setInputFiles({ name: "people.csv", mimeType: "text/csv", buffer: Buffer.from("name,role\nAda Lovelace,Researcher\nGrace Hopper,Engineer") });
  await page.getByRole("button", { name: "Documents" }).click();
  await expect(page.getByText("people.csv", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review" }).click();
  await page.getByRole("button", { name: "Rebuild candidates" }).click();
  await expect(page.getByText("Inference proposes. You decide.")).toBeVisible();
  await page.getByRole("button", { name: "Evidence" }).click();
  await page.getByRole("button", { name: "Retrieve" }).click();
  await expect(page.getByText(/evidence answer/i)).toBeVisible();
});

test("canvas and layered graph render without a backend", async ({ page }) => {
  await page.getByRole("button", { name: "Canvas" }).click();
  await page.getByRole("button", { name: "New canvas" }).click();
  await page.getByRole("button", { name: "Add current note" }).click();
  await expect(page.locator(".canvas-node")).toHaveCount(1);
  await page.getByRole("button", { name: "Graph" }).click();
  await expect(page.locator(".graph-canvas")).toBeVisible();
});
