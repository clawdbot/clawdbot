import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import "../../../styles.css";
import type { FileSidebarContent } from "./chat-sidebar.ts";
import "./chat-sidebar.ts";

// The root jsdom ui shard also collects *.browser.test.ts files; CodeMirror
// needs a real DOM, so this suite only runs in the checks-ui Chromium project.
// Importing vitest/browser statically would throw during jsdom collection.
const browserMode = "__vitest_browser__" in globalThis;
let userEvent: (typeof import("vitest/browser"))["userEvent"];

beforeAll(async () => {
  if (browserMode) {
    ({ userEvent } = await import("vitest/browser"));
  }
});

type DetailPanel = HTMLElement & {
  content: FileSidebarContent;
  updateComplete: Promise<unknown>;
};

const mounted: DetailPanel[] = [];

async function mountFile(content: FileSidebarContent): Promise<DetailPanel> {
  const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
  panel.content = content;
  document.body.append(panel);
  mounted.push(panel);
  await panel.updateComplete;
  await expect.poll(() => panel.querySelector(".cm-editor")).not.toBeNull();
  return panel;
}

function button(panel: DetailPanel, label: string): HTMLButtonElement {
  const match = Array.from(panel.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) =>
      candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
  );
  if (!match) {
    throw new Error(`Missing ${label} button`);
  }
  return match;
}

afterEach(() => {
  for (const panel of mounted.splice(0)) {
    panel.remove();
  }
});

describe.runIf(browserMode)("chat file editor", () => {
  it("renders content and decorates the requested line", async () => {
    const panel = await mountFile({
      kind: "file",
      path: "src/example.ts",
      name: "example.ts",
      content: "const first = 1;\nconst second = 2;",
      line: 2,
    });

    expect(panel.querySelector(".cm-content")?.textContent).toContain("const second = 2;");
    const target = panel.querySelector(".file-view__line--target");
    expect(target?.getAttribute("data-line")).toBe("2");
  });

  it("enables save after an edit and keeps the saved content", async () => {
    const save = vi.fn().mockResolvedValue({ ok: true, hash: "hash-2" });
    const panel = await mountFile({
      kind: "file",
      path: "notes.txt",
      name: "notes.txt",
      content: "before",
      edit: { hash: "hash-1", save, fetchLatest: vi.fn() },
    });

    await userEvent.click(button(panel, "Edit file"));
    const editor = panel.querySelector<HTMLElement>(".cm-content");
    expect(editor).not.toBeNull();
    await userEvent.fill(editor!, "after");
    const saveButton = button(panel, "Save");
    expect(saveButton.disabled).toBe(false);
    await userEvent.click(saveButton);

    await expect.poll(() => save.mock.calls.length).toBe(1);
    expect(save).toHaveBeenCalledWith({ content: "after", expectedHash: "hash-1" });
    await expect.poll(() => button(panel, "Save").disabled).toBe(true);
    expect(panel.querySelector(".cm-content")?.textContent).toContain("after");
  });

  it("round-trips CRLF line endings through an edit and save", async () => {
    const save = vi.fn().mockResolvedValue({ ok: true, hash: "hash-2" });
    const panel = await mountFile({
      kind: "file",
      path: "notes.txt",
      name: "notes.txt",
      content: "alpha\r\nbeta",
      edit: { hash: "hash-1", save, fetchLatest: vi.fn() },
    });

    await userEvent.click(button(panel, "Edit file"));
    const editor = panel.querySelector<HTMLElement>(".cm-content");
    expect(editor).not.toBeNull();
    await userEvent.type(editor!, "x");
    await userEvent.click(button(panel, "Save"));

    await expect.poll(() => save.mock.calls.length).toBe(1);
    const saved = save.mock.calls[0][0] as { content: string };
    expect(saved.content).toContain("\r\n");
    expect(saved.content).toContain("x");
  });

  it("keeps edits made while a save is in flight dirty", async () => {
    let finishSave: ((outcome: { ok: true; hash: string }) => void) | undefined;
    const save = vi.fn().mockImplementation(
      () =>
        new Promise<{ ok: true; hash: string }>((resolve) => {
          finishSave = resolve;
        }),
    );
    const panel = await mountFile({
      kind: "file",
      path: "notes.txt",
      name: "notes.txt",
      content: "before",
      edit: { hash: "hash-1", save, fetchLatest: vi.fn() },
    });

    await userEvent.click(button(panel, "Edit file"));
    const editor = panel.querySelector<HTMLElement>(".cm-content")!;
    await userEvent.fill(editor, "submitted");
    await userEvent.click(button(panel, "Save"));
    await userEvent.fill(editor, "newer");
    finishSave?.({ ok: true, hash: "hash-2" });

    await expect.poll(() => button(panel, "Save").textContent?.trim()).toBe("Save");
    expect(button(panel, "Save").disabled).toBe(false);
    expect(editor.textContent).toContain("newer");
    await userEvent.click(button(panel, "Discard"));
  });

  it("restores an unsaved draft after the detail panel is closed", async () => {
    const originalEdit = { hash: "hash-1", save: vi.fn(), fetchLatest: vi.fn() };
    const first = await mountFile({
      kind: "file",
      draftKey: "session-a\u0000notes.txt",
      path: "notes.txt",
      name: "notes.txt",
      content: "before",
      edit: originalEdit,
    });

    await userEvent.click(button(first, "Edit file"));
    await userEvent.fill(first.querySelector<HTMLElement>(".cm-content")!, "unsaved draft");
    first.remove();

    const save = vi.fn().mockResolvedValue({ ok: true, hash: "hash-3" });
    const reopened = await mountFile({
      kind: "file",
      draftKey: "session-a\u0000notes.txt",
      path: "notes.txt",
      name: "notes.txt",
      content: "latest",
      edit: { hash: "hash-2", save, fetchLatest: vi.fn() },
    });
    await expect
      .poll(() => reopened.querySelector(".cm-content")?.textContent)
      .toContain("unsaved");
    expect(reopened.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("true");
    expect(button(reopened, "Save").disabled).toBe(false);

    await userEvent.click(button(reopened, "Discard"));
    await userEvent.click(button(reopened, "Edit file"));
    await userEvent.fill(reopened.querySelector<HTMLElement>(".cm-content")!, "new edit");
    await userEvent.click(button(reopened, "Save"));
    await expect.poll(() => save.mock.calls.length).toBe(1);
    expect(save).toHaveBeenCalledWith({ content: "new edit", expectedHash: "hash-2" });
  });

  it("scopes retained drafts to the session file identity", async () => {
    const edit = { hash: "hash-1", save: vi.fn(), fetchLatest: vi.fn() };
    const first = await mountFile({
      kind: "file",
      draftKey: "gateway-a\u0000pane-left\u0000session-a\u0000shared.txt",
      path: "shared.txt",
      name: "shared.txt",
      content: "session a",
      edit,
    });

    await userEvent.click(button(first, "Edit file"));
    await userEvent.fill(first.querySelector<HTMLElement>(".cm-content")!, "session a draft");
    first.remove();

    const otherSession = await mountFile({
      kind: "file",
      draftKey: "gateway-a\u0000pane-right\u0000session-a\u0000shared.txt",
      path: "shared.txt",
      name: "shared.txt",
      content: "session b",
      edit,
    });
    expect(otherSession.querySelector(".cm-content")?.textContent).toContain("session b");
    expect(otherSession.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe(
      "false",
    );

    const restored = await mountFile({
      kind: "file",
      draftKey: "gateway-a\u0000pane-left\u0000session-a\u0000shared.txt",
      path: "shared.txt",
      name: "shared.txt",
      content: "session a",
      edit,
    });
    await expect.poll(() => restored.querySelector(".cm-content")?.textContent).toContain("draft");
    await userEvent.click(button(restored, "Discard"));
  });

  it("reloads the latest content after a save conflict", async () => {
    const save = vi.fn().mockResolvedValue({ ok: false, code: "conflict" });
    const fetchLatest = vi
      .fn()
      .mockResolvedValue({ content: "latest", hash: "hash-2", editable: true });
    const panel = await mountFile({
      kind: "file",
      path: "notes.txt",
      name: "notes.txt",
      content: "before",
      edit: { hash: "hash-1", save, fetchLatest },
    });

    await userEvent.click(button(panel, "Edit file"));
    await userEvent.fill(panel.querySelector<HTMLElement>(".cm-content")!, "local");
    await userEvent.click(button(panel, "Save"));
    await expect
      .poll(() => panel.querySelector('[role="alert"]')?.textContent)
      .toContain("File changed on disk since it was loaded.");

    await userEvent.click(button(panel, "Reload"));
    await expect.poll(() => panel.querySelector(".cm-content")?.textContent).toContain("latest");
    expect(fetchLatest).toHaveBeenCalledOnce();
    expect(button(panel, "Save").disabled).toBe(true);
  });

  it("drops edit mode when a conflict reload returns non-editable content", async () => {
    const save = vi.fn().mockResolvedValue({ ok: false, code: "conflict" });
    const fetchLatest = vi.fn().mockResolvedValue({
      content: "mixed\r\nendings\nnow",
      hash: "hash-2",
      editable: false,
    });
    const panel = await mountFile({
      kind: "file",
      path: "notes.txt",
      name: "notes.txt",
      content: "before",
      edit: { hash: "hash-1", save, fetchLatest },
    });

    await userEvent.click(button(panel, "Edit file"));
    await userEvent.fill(panel.querySelector<HTMLElement>(".cm-content")!, "local");
    await userEvent.click(button(panel, "Save"));
    await expect.poll(() => panel.querySelector('[role="alert"]')).not.toBeNull();
    await userEvent.click(button(panel, "Reload"));

    await expect.poll(() => panel.querySelector(".cm-content")?.textContent).toContain("mixed");
    expect(panel.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("false");
    expect(
      Array.from(panel.querySelectorAll("button")).some(
        (candidate) => candidate.getAttribute("aria-label") === "Edit file",
      ),
    ).toBe(false);
  });

  it("makes the editor read-only while reloading a conflict", async () => {
    let finishReload:
      | ((latest: { content: string; hash: string; editable: boolean }) => void)
      | undefined;
    const save = vi.fn().mockResolvedValue({ ok: false, code: "conflict" });
    const fetchLatest = vi.fn().mockImplementation(
      () =>
        new Promise<{ content: string; hash: string; editable: boolean }>((resolve) => {
          finishReload = resolve;
        }),
    );
    const panel = await mountFile({
      kind: "file",
      path: "notes.txt",
      name: "notes.txt",
      content: "before",
      edit: { hash: "hash-1", save, fetchLatest },
    });

    await userEvent.click(button(panel, "Edit file"));
    await userEvent.fill(panel.querySelector<HTMLElement>(".cm-content")!, "local");
    await userEvent.click(button(panel, "Save"));
    await expect
      .poll(() => panel.querySelector('[role="alert"]')?.textContent)
      .toContain("File changed on disk since it was loaded.");
    await userEvent.click(button(panel, "Reload"));

    await expect
      .poll(() => panel.querySelector(".cm-content")?.getAttribute("contenteditable"))
      .toBe("false");
    finishReload?.({ content: "latest", hash: "hash-2", editable: true });
    await expect.poll(() => panel.querySelector(".cm-content")?.textContent).toContain("latest");
    expect(panel.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("true");
  });
});
