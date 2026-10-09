import type { FileMap } from "../template";

/** Checked-in generated-style fixture used by the opt-in Stage 15 browser gate. */
export const STAGE15_BROWSER_GOLDEN_FILES: FileMap = {
  "src/app/page.tsx": `"use client";
import { useEffect, useMemo, useState } from "react";

type Item = { id: string; title: string; dueDate: string; status: "planned" | "done" };
const STORAGE_KEY = "vf-stage15-golden-items";

export default function HomePage() {
  const [items, setItems] = useState<Item[]>([]);
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("2030-05-10");
  const [query, setQuery] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try { setItems(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as Item[]); } catch { setItems([]); }
    setReady(true);
  }, []);
  useEffect(() => { if (ready) localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); }, [items, ready]);

  const visible = useMemo(() => items.filter((item) => item.title.toLowerCase().includes(query.toLowerCase())), [items, query]);
  function addItem() {
    const clean = title.trim();
    if (!clean) return;
    setItems((current) => [...current, { id: crypto.randomUUID(), title: clean, dueDate, status: "planned" }]);
    setTitle("");
  }
  function moveItem(id: string, status: Item["status"]) {
    setItems((current) => current.map((item) => item.id === id ? { ...item, status } : item));
  }
  function exportCsv() {
    const csv = ["title,due_date,status", ...items.map((item) => [item.title, item.dueDate, item.status].map((value) => JSON.stringify(value)).join(","))].join("\\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    link.download = "stage15-items.csv";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return <main style={{ maxWidth: 960, margin: "0 auto", padding: 24, fontFamily: "system-ui" }}>
    <h1>Stage 15 Planning Board</h1>
    <section aria-labelledby="add-heading">
      <h2 id="add-heading">Add work item</h2>
      <label>Title <input value={title} onChange={(event) => setTitle(event.target.value)} /></label>{" "}
      <label>Due date <input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label>{" "}
      <button data-vf-workflow="create-work-item" data-vf-control="save-work-item" onClick={addItem}>Save work item</button>
    </section>
    <section aria-labelledby="find-heading">
      <h2 id="find-heading">Find items</h2>
      <label>Search <input value={query} onChange={(event) => setQuery(event.target.value)} /></label>{" "}
      <button data-vf-workflow="export-items" data-vf-control="export-csv" onClick={exportCsv}>Export CSV</button>
    </section>
    <section aria-label="Planning board" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 24 }}>
      {(["planned", "done"] as const).map((status) => <div key={status} data-column={status} onDragOver={(event) => event.preventDefault()} onDrop={(event) => moveItem(event.dataTransfer.getData("application/x-vf-record"), status)} style={{ minHeight: 180, padding: 16, border: "1px solid #999" }}>
        <h2>{status === "planned" ? "Planned" : "Done"}</h2>
        {visible.filter((item) => item.status === status).map((item) => <article key={item.id} draggable data-vf-entity="work_item" data-vf-record={item.id} onDragStart={(event) => event.dataTransfer.setData("application/x-vf-record", item.id)} style={{ padding: 12, marginBottom: 8, border: "1px solid #555" }}>
          <strong>{item.title}</strong><div>{item.dueDate}</div>
        </article>)}
      </div>)}
    </section>
  </main>;
}
`,
  "e2e/generated/stage15-golden.spec.ts": `import { expect, test } from "@playwright/test";

test("Stage 15 golden create, reload, search, drag, and export", async ({ page }) => {
  const title = "Golden item " + Date.now();
  await page.goto("/");
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Due date").fill("2030-05-10");
  await page.locator('[data-vf-control="save-work-item"]').click();
  await expect(page.locator('[data-vf-entity="work_item"]', { hasText: title })).toBeVisible();

  await page.reload();
  await page.getByLabel("Search").fill(title);
  const card = page.locator('[data-vf-entity="work_item"]', { hasText: title });
  await expect(card).toBeVisible();
  await card.dragTo(page.locator('[data-column="done"]'));
  await page.reload();
  await expect(page.locator('[data-column="done"] [data-vf-entity="work_item"]', { hasText: title })).toBeVisible();

  const download = page.waitForEvent("download");
  await page.locator('[data-vf-control="export-csv"]').click();
  expect((await download).suggestedFilename()).toBe("stage15-items.csv");
});
`,
};
