/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { t } from "../../../i18n/index.ts";
import {
  formatDistinctCollapsedToolSummaryText,
  formatCollapsedToolPreviewText,
  formatCollapsedToolSummaryText,
  resolveCollapsedToolArgumentPreview,
} from "../../../lib/chat/tool-cards.ts";
import { renderToolCard, renderToolPreview } from "./chat-tool-cards.ts";

function requireFirstMockArg(
  mock: ReturnType<typeof vi.fn>,
  label: string,
): Record<string, unknown> {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  const [arg] = call;
  if (!arg || typeof arg !== "object" || Array.isArray(arg)) {
    throw new Error(`expected ${label} payload`);
  }
  return arg;
}

function selectText(element: Element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function pointerClick(element: Element) {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
}

describe("tool-cards", () => {
  it("routes MCP App previews through the dedicated double-iframe host", async () => {
    const container = document.createElement("div");
    render(
      renderToolPreview(
        {
          kind: "canvas",
          surface: "assistant_message",
          render: "url",
          viewId: "cv_app",
          mcpApp: { viewId: "cv_app" },
        },
        "chat_message",
        { sessionKey: "agent:main:main" },
      ),
      container,
    );

    const view = container.querySelector("mcp-app-view");
    expect(view).not.toBeNull();
    expect(view?.getAttribute("src")).toBeNull();
    expect((view as { sessionKey?: string }).sessionKey).toBe("agent:main:main");
    expect((view as { viewId?: string }).viewId).toBe("cv_app");
    expect((view as { height?: number }).height).toBe(600);
    await customElements.whenDefined("mcp-app-view");
    expect(customElements.get("mcp-app-view")).toBeDefined();
    expect((view as { sessionKey?: string }).sessionKey).toBe("agent:main:main");
    expect((view as { viewId?: string }).viewId).toBe("cv_app");

    const toolContainer = document.createElement("div");
    render(
      renderToolPreview(
        {
          kind: "canvas",
          surface: "assistant_message",
          render: "url",
          mcpApp: { viewId: "cv_app" },
        },
        "chat_tool",
        { sessionKey: "agent:main:main" },
      ),
      toolContainer,
    );
    expect(toolContainer.querySelector("mcp-app-view")).toBeNull();
  });

  it("keeps ordinary canvas previews off the MCP Apps chunk", () => {
    const container = document.createElement("div");
    render(
      renderToolPreview(
        {
          kind: "canvas",
          surface: "assistant_message",
          render: "url",
          viewId: "cv_canvas",
          url: "https://canvas.example/widget",
        },
        "chat_message",
        { allowExternalEmbedUrls: true },
      ),
      container,
    );

    expect(container.querySelector("iframe")).not.toBeNull();
  });

  it("keeps selected summary text from toggling the disclosure", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const toggle = vi.fn();
    render(
      renderToolCard(
        {
          id: "msg:selectable",
          name: "web_search",
          args: { query: "openclaw" },
        },
        { messageKey: "test-message", expanded: false, onToggleExpanded: toggle },
      ),
      container,
    );

    const summary = container.querySelector<HTMLButtonElement>(".chat-tool-msg-summary");
    const label = summary?.querySelector(".chat-tool-msg-summary__label");
    expect(summary).not.toBeNull();
    expect(label).not.toBeNull();
    selectText(label!);
    pointerClick(summary!);
    expect(toggle).not.toHaveBeenCalled();

    window.getSelection()?.removeAllRanges();
    pointerClick(summary!);
    expect(toggle).toHaveBeenCalledWith("msg:selectable");
    container.remove();
  });

  it("keeps a running card closed by default", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:running",
          name: "bash",
          args: { command: "pnpm test" },
          live: true,
        },
        { messageKey: "test-message", expanded: false, runActive: true, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    expect(container.querySelector(".chat-tool-msg-body")).toBeNull();
    expect(container.querySelector(".chat-tool-msg-summary")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("renders expanded cards with key-value args and an output section", () => {
    const container = document.createElement("div");
    const toggle = vi.fn();
    render(
      renderToolCard(
        {
          id: "msg:4:call-4",
          name: "browser.open",
          args: { url: "https://example.com" },
          inputText: '{\n  "url": "https://example.com"\n}',
          outputText: "Opened page",
        },
        { messageKey: "test-message", expanded: true, onToggleExpanded: toggle },
      ),
      container,
    );

    // Simple object args render as key-value rows instead of a raw JSON block.
    const kvRows = Array.from(container.querySelectorAll(".chat-tool-kv__row"));
    expect(kvRows).toHaveLength(1);
    expect(kvRows[0]?.querySelector(".chat-tool-kv__key")?.textContent).toBe("url:");
    expect(kvRows[0]?.querySelector(".chat-tool-kv__value")?.textContent).toBe(
      "https://example.com",
    );
    const blocks = Array.from(container.querySelectorAll(".chat-tool-card__block"));
    expect(blocks[0]?.querySelector(".chat-tool-card__block-label")).toBeNull();
    expect(blocks[0]?.querySelector("code")?.textContent).toBe("Opened page");
  });

  it("switches a completed patch between mutually exclusive diff and raw bodies", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    render(
      renderToolCard(
        {
          id: "msg:patch:multi",
          name: "apply_patch",
          args: {
            changes: [
              {
                path: "src/a.ts",
                kind: { type: "update" },
                diff: [
                  "--- a/src/a.ts",
                  "+++ b/src/a.ts",
                  "@@ -1 +1 @@",
                  "-old a",
                  "+new a",
                  "",
                ].join("\n"),
              },
              {
                path: "src/b.ts",
                kind: { type: "add" },
                diff: "new b\n",
              },
            ],
          },
          outputText: "Applied patch",
        },
        { messageKey: "test-message", expanded: true, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    const diff = container.querySelector(".chat-diff");
    expect(diff?.getAttribute("aria-label")).toBe("File changes");
    const fileRows = Array.from(diff?.querySelectorAll(".chat-diff__row--file") ?? []);
    expect(fileRows.map((row) => row.querySelector(".chat-diff__text")?.textContent)).toEqual([
      "Update src/a.ts",
      "Add src/b.ts",
    ]);
    expect(fileRows.every((row) => row.querySelector(".chat-diff__gutter") !== null)).toBe(true);
    expect(diff?.querySelector(".chat-diff__row--del .chat-diff__text")?.textContent).toBe("old a");
    expect(
      Array.from(diff?.querySelectorAll(".chat-diff__row--add .chat-diff__text") ?? []).map(
        (row) => row.textContent,
      ),
    ).toEqual(["new a", "new b"]);

    const tabGroup = container.querySelector<HTMLElement & { updateComplete: Promise<unknown> }>(
      "wa-tab-group",
    );
    const tabs = Array.from(
      container.querySelectorAll<HTMLElement & { updateComplete: Promise<unknown> }>("wa-tab"),
    );
    await tabGroup?.updateComplete;
    await Promise.all(tabs.map((tab) => tab.updateComplete));
    expect(
      tabGroup?.shadowRoot?.querySelector('[role="tablist"]')?.getAttribute("aria-label"),
    ).toBe("Tool detail view");
    expect(tabs.map((tab) => [tab.textContent?.trim(), tab.getAttribute("aria-selected")])).toEqual(
      [
        ["Diff", "true"],
        ["Raw", "false"],
      ],
    );
    const diffBody = container.querySelector<HTMLElement>('wa-tab-panel[name="diff"]');
    const rawBody = container.querySelector<HTMLElement>('wa-tab-panel[name="raw"]');
    expect(diffBody?.hasAttribute("active")).toBe(true);
    expect(rawBody?.hasAttribute("active")).toBe(false);

    tabs[1]?.click();
    await tabGroup?.updateComplete;
    await Promise.all(tabs.map((tab) => tab.updateComplete));
    expect(diffBody?.hasAttribute("active")).toBe(false);
    expect(rawBody?.hasAttribute("active")).toBe(true);
    expect(rawBody?.querySelector("code")?.textContent).toBe("Applied patch");
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true"]);

    tabGroup?.setAttribute("aria-label", "Translated tool detail view");
    render(
      renderToolCard(
        {
          id: "msg:patch:multi",
          name: "apply_patch",
          args: {
            changes: [{ path: "src/a.ts", kind: { type: "update" }, diff: "-old\n+new\n" }],
          },
          outputText: "Applied patch",
        },
        { messageKey: "test-message", expanded: true, onToggleExpanded: vi.fn() },
      ),
      container,
    );
    await tabGroup?.updateComplete;
    expect(
      tabGroup?.shadowRoot?.querySelector('[role="tablist"]')?.getAttribute("aria-label"),
    ).toBe("Tool detail view");
    container.remove();
  });

  it("shows failed edit output before the attempted diff", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    render(
      renderToolCard(
        {
          id: "msg:edit:failed",
          name: "edit",
          args: { path: "src/a.ts", oldText: "before", newText: "after" },
          outputText: "Patch context did not match",
          completed: true,
          isError: true,
        },
        { messageKey: "test-message", expanded: true, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    const tabGroup = container.querySelector<HTMLElement & { updateComplete: Promise<unknown> }>(
      "wa-tab-group",
    );
    await tabGroup?.updateComplete;

    expect(container.querySelector('wa-tab[panel="raw"]')?.hasAttribute("active")).toBe(true);
    expect(container.querySelector('wa-tab-panel[name="raw"]')?.hasAttribute("active")).toBe(true);
    expect(container.querySelector('wa-tab-panel[name="raw"] code')?.textContent).toBe(
      "Patch context did not match",
    );
    container.remove();
  });

  it("labels a completed Codex file creation from its recorded operation", () => {
    const container = document.createElement("div");
    const onOpenWorkspaceFile = vi.fn();
    const onToggleExpanded = vi.fn();
    render(
      renderToolCard(
        {
          id: "msg:patch:add",
          name: "apply_patch",
          args: {
            changes: [
              {
                path: "src/new.ts",
                kind: { type: "add" },
                diff: "export const created = true;\n",
              },
            ],
          },
          completed: true,
        },
        { messageKey: "test-message", expanded: false, onOpenWorkspaceFile, onToggleExpanded },
      ),
      container,
    );

    expect(container.querySelector(".chat-tool-row__verb")?.textContent).toBe("Created");
    expect(container.querySelector(".chat-tool-row__file-link")?.textContent?.trim()).toBe(
      "new.ts",
    );
    container.querySelector<HTMLButtonElement>(".chat-tool-row__file-link")?.click();
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith({ path: "src/new.ts" });
    expect(onToggleExpanded).not.toHaveBeenCalled();

    container.querySelector<HTMLButtonElement>(".chat-tool-row__toggle")?.click();
    expect(onToggleExpanded).toHaveBeenCalledWith("msg:patch:add");
    expect(onOpenWorkspaceFile).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "multi-file",
      patch: [
        "*** Begin Patch",
        "*** Update File: src/a.ts",
        "@@",
        "-old",
        "+new",
        "*** Add File: src/b.ts",
        "+added",
        "*** End Patch",
      ].join("\n"),
      target: "2 files",
    },
    {
      label: "moved",
      patch: [
        "*** Begin Patch",
        "*** Update File: src/old.ts",
        "*** Move to: src/new.ts",
        "@@",
        "-old",
        "+new",
        "*** End Patch",
      ].join("\n"),
      target: "old.ts → new.ts",
    },
    {
      // A successful delete removes its own target, so the workspace loader
      // would only ever report "Failed to load".
      label: "deleted",
      patch: ["*** Begin Patch", "*** Delete File: src/gone.ts", "*** End Patch"].join("\n"),
      target: "gone.ts",
    },
  ])("keeps $label patch summaries non-navigable", ({ patch, target }) => {
    const container = document.createElement("div");
    const onOpenWorkspaceFile = vi.fn();
    const onToggleExpanded = vi.fn();
    render(
      renderToolCard(
        {
          id: `msg:patch:${target}`,
          name: "apply_patch",
          args: { patch },
          completed: true,
        },
        { messageKey: "test-message", expanded: false, onOpenWorkspaceFile, onToggleExpanded },
      ),
      container,
    );

    expect(container.querySelector(".chat-tool-row--file")).toBeNull();
    expect(container.querySelector(".chat-tool-row__target")?.textContent).toBe(target);
    container.querySelector<HTMLButtonElement>(".chat-tool-msg-summary")?.click();
    expect(onToggleExpanded).toHaveBeenCalledOnce();
    expect(onOpenWorkspaceFile).not.toHaveBeenCalled();
  });

  it("renders edit and write rows from their result outcome", () => {
    const mutations = [
      {
        name: "edit",
        args: { path: "/repo/src/a.ts", oldText: "old", newText: "new" },
        verbs: { running: "Editing", succeeded: "Edited", neutral: "Edit" },
      },
      {
        name: "write",
        args: { path: "/repo/src/b.ts", content: "new file\n" },
        verbs: { running: "Writing", succeeded: "Wrote", neutral: "Write" },
      },
    ] as const;
    const states = [
      {
        name: "running",
        card: { live: true, liveDiffStat: { added: 12, removed: 3 } },
        runActive: true,
        verb: "running",
        label: "Attempted changes",
        hasStat: true,
        failed: false,
      },
      {
        name: "succeeded",
        card: { completed: true },
        runActive: false,
        verb: "succeeded",
        label: "File changes",
        hasStat: true,
        failed: false,
      },
      {
        name: "failed after recovery",
        card: { completed: true, isError: true },
        runActive: false,
        verb: "neutral",
        label: "Attempted changes",
        hasStat: false,
        failed: true,
      },
      {
        name: "call only",
        card: {},
        runActive: false,
        verb: "neutral",
        label: "Attempted changes",
        hasStat: false,
        failed: false,
      },
      {
        name: "empty successful result",
        card: { completed: true, outputText: "" },
        runActive: false,
        verb: "succeeded",
        label: "File changes",
        hasStat: true,
        failed: false,
      },
    ] as const;

    for (const mutation of mutations) {
      for (const state of states) {
        const container = document.createElement("div");
        render(
          renderToolCard(
            {
              id: `${mutation.name}:${state.name}`,
              name: mutation.name,
              args: mutation.args,
              ...state.card,
            },
            {
              messageKey: "test-message",
              expanded: true,
              onToggleExpanded: vi.fn(),
              runActive: state.runActive,
            },
          ),
          container,
        );

        expect(container.querySelector(".chat-tool-row__verb")?.textContent).toBe(
          mutation.verbs[state.verb],
        );
        expect(container.querySelector(".chat-diff")?.getAttribute("aria-label")).toBe(state.label);
        expect(container.querySelector(".chat-diffstat") !== null).toBe(state.hasStat);
        if (state.failed) {
          expect(container.querySelector(".chat-tool-card__outcome")?.textContent).toBe("failed");
        }
        expect(container.querySelector(".chat-tool-msg-summary--error")).toBeNull();
      }
    }
  });

  it.each(
    [
      {
        name: "edit",
        args: { path: "src/edit.ts", oldText: "old edit", newText: "new edit" },
        copiedText: "new edit",
      },
      {
        name: "write",
        args: { path: "src/write.ts", content: "new file\n" },
        copiedText: "new file",
      },
      {
        name: "apply_patch",
        args: {
          changes: [
            {
              path: "src/patch.ts",
              kind: { type: "update" },
              diff: "--- a/src/patch.ts\n+++ b/src/patch.ts\n@@ -1 +1 @@\n-old patch\n+new patch\n",
            },
          ],
        },
        copiedText: "new patch",
      },
    ].flatMap((tool) =>
      [
        { failed: false, feedback: "Copied!" },
        { failed: true, feedback: "Copy failed" },
      ].map((outcome) => ({
        name: tool.name,
        args: tool.args,
        copiedText: tool.copiedText,
        failed: outcome.failed,
        feedback: outcome.feedback,
      })),
    ),
  )("shows $feedback after copying a completed $name diff", async (tool) => {
    const writeText = tool.failed
      ? vi.fn().mockRejectedValue(new DOMException("Clipboard access denied", "NotAllowedError"))
      : vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const container = document.body.appendChild(document.createElement("div"));
    const onOpenSidebar = vi.fn();

    try {
      render(
        renderToolCard(
          {
            id: `msg:${tool.name}:copy`,
            name: tool.name,
            args: tool.args,
            completed: true,
          },
          { messageKey: "test-message", expanded: true, onToggleExpanded: vi.fn(), onOpenSidebar },
        ),
        container,
      );

      const copyButton = container.querySelector<HTMLButtonElement>(
        '.chat-tool-card__actions button[aria-label="Copy"]',
      );
      expect(copyButton).toBeInstanceOf(HTMLButtonElement);
      copyButton!.click();

      await vi.waitFor(() => expect(copyButton!.getAttribute("aria-label")).toBe(tool.feedback));

      expect(writeText).toHaveBeenCalledWith(expect.stringContaining(tool.copiedText));
      const feedback = copyButton!.parentElement?.querySelector<HTMLElement>('[role="status"]');
      expect(feedback?.textContent).toBe(tool.feedback);
      expect(feedback?.hidden).toBe(false);

      const sidebarButton = container.querySelector<HTMLButtonElement>(
        `.chat-tool-card__actions button[aria-label="${t("chat.toolCards.openDetails")}"]`,
      );
      expect(sidebarButton).toBeInstanceOf(HTMLButtonElement);
      sidebarButton!.click();
      expect(onOpenSidebar).toHaveBeenCalledOnce();
    } finally {
      container.remove();
      vi.unstubAllGlobals();
    }
  });

  it.each([
    { name: "read", args: { path: "packages/app/src/read.ts" }, path: "packages/app/src/read.ts" },
    {
      name: "edit",
      args: { file_path: "packages/app/src/edit.ts", oldText: "old", newText: "new" },
      path: "packages/app/src/edit.ts",
    },
    {
      name: "write",
      args: { path: "packages/app/src/write.ts", content: "new" },
      path: "packages/app/src/write.ts",
    },
  ])("opens the raw file path from an expanded $name card", ({ name, args, path }) => {
    const container = document.createElement("div");
    const onOpenWorkspaceFile = vi.fn();
    render(
      renderToolCard(
        {
          id: `msg:${name}:open`,
          name,
          args,
          completed: true,
        },
        {
          messageKey: "test-message",
          expanded: true,
          onOpenWorkspaceFile,
          onToggleExpanded: vi.fn(),
        },
      ),
      container,
    );

    const pathButton = container.querySelector<HTMLButtonElement>(
      '.chat-tool-card__detail-link[title="Open file"]',
    );
    expect(pathButton).toBeInstanceOf(HTMLButtonElement);
    pathButton!.click();
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith({ path });
  });

  it("keeps read offsets and limits visible in expanded args", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:read:range",
          name: "read",
          args: { path: "/repo/src/a.ts", offset: 40, limit: 20 },
          inputText: JSON.stringify({ path: "/repo/src/a.ts", offset: 40, limit: 20 }),
        },
        { messageKey: "test-message", expanded: true, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    expect(container.querySelector(".chat-tool-row__verb")?.textContent).toBe("Read");
    const rows = Array.from(container.querySelectorAll(".chat-tool-kv__row"));
    expect(
      rows.map((row) => [
        row.querySelector(".chat-tool-kv__key")?.textContent,
        row.querySelector(".chat-tool-kv__value")?.textContent,
      ]),
    ).toEqual([
      ["offset:", "40"],
      ["limit:", "20"],
    ]);
  });

  it("does not repeat the tool identity in expanded details", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:4a:call-4a",
          name: "skill_workshop",
          args: { action: "create" },
          inputText: '{\n  "action": "create"\n}',
          outputText: "Proposal created",
        },
        {
          messageKey: "test-message",
          expanded: true,
          onOpenSidebar: vi.fn(),
          onToggleExpanded: vi.fn(),
        },
      ),
      container,
    );

    expect(container.textContent?.match(/Skill Workshop/g)).toHaveLength(1);
    const body = container.querySelector(".chat-tool-msg-body");
    expect(body?.textContent).not.toContain("Skill Workshop");
    const kvRow = body?.querySelector(".chat-tool-kv__row");
    expect(kvRow?.querySelector(".chat-tool-kv__key")?.textContent).toBe("action:");
    expect(kvRow?.querySelector(".chat-tool-kv__value")?.textContent).toBe("create");
    expect(container.querySelector(".chat-tool-card__action-btn")).toBeInstanceOf(
      HTMLButtonElement,
    );
  });

  it("renders expanded tool calls without an inline output block when no output is present", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:4b:call-4b",
          name: "sessions_spawn",
          args: { mode: "session", thread: true },
          inputText: '{\n  "mode": "session",\n  "thread": true\n}',
        },
        { messageKey: "test-message", expanded: true, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    // No raw blocks: simple args render as key-value rows and there is no output.
    expect(container.querySelector(".chat-tool-card__block")).toBeNull();
    const kvRows = Array.from(container.querySelectorAll(".chat-tool-kv__row"));
    expect(
      kvRows.map((row) => [
        row.querySelector(".chat-tool-kv__key")?.textContent,
        row.querySelector(".chat-tool-kv__value")?.textContent,
      ]),
    ).toEqual([
      ["mode:", "session"],
      ["thread:", "true"],
    ]);
  });

  it("labels collapsed tool calls with the display summary", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:5:call-5",
          name: "sessions_spawn",
          args: { mode: "run" },
          inputText: '{\n  "mode": "run"\n}',
        },
        { messageKey: "test-message", expanded: false, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    const summaryButton = container.querySelector("button.chat-tool-msg-summary");
    expect(summaryButton?.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe(
      "Sub-agent",
    );
    expect(summaryButton?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".chat-tool-msg-body")).toBeNull();
  });

  it("shows the first message line in collapsed message tool rows", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:5-message:call-5-message",
          name: "message",
          args: {
            action: "send",
            channel: "reef",
            target: "@molty",
            message: "Hello Molty, first claw-to-claw hello.\nSecond line stays in details.",
          },
          inputText: "message input",
        },
        { messageKey: "test-message", expanded: false, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    const summaryButton = container.querySelector("button.chat-tool-msg-summary");
    expect(summaryButton?.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe(
      "Message",
    );
    expect(summaryButton?.querySelector(".chat-tool-msg-summary__names")?.textContent).toBe(
      "Hello Molty, first claw-to-claw hello.",
    );
  });

  it("previews common intent arguments across generic tools", () => {
    expect(resolveCollapsedToolArgumentPreview({ task: "Review the PR" })).toBe("Review the PR");
    expect(resolveCollapsedToolArgumentPreview({ prompt: "Draw a crab" })).toBe("Draw a crab");
    expect(resolveCollapsedToolArgumentPreview({ text: "First line\nSecond line" })).toBe(
      "First line",
    );
    expect(resolveCollapsedToolArgumentPreview({ query: " \r\rSecond line" })).toBe("Second line");
    const credential = ["sk", "1234567890abcdef"].join("-");
    expect(
      resolveCollapsedToolArgumentPreview({ description: `OPENAI_API_KEY=${credential}` }),
    ).not.toContain(credential);
  });

  it("keeps tool display labels primary for collapsed result rows with action details", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:5a:call-5a",
          name: "skill_workshop",
          args: { action: "create" },
          inputText: '{\n  "action": "create"\n}',
          outputText: "Proposal created",
        },
        { messageKey: "test-message", expanded: false, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    const summaryButton = container.querySelector("button.chat-tool-msg-summary");
    expect(summaryButton?.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe(
      "Skill Workshop",
    );
    expect(summaryButton?.querySelector(".chat-tool-msg-summary__names")?.textContent).toBe(
      "create",
    );
    expect(summaryButton?.textContent).not.toContain("output");
  });

  it("cleans connector copy from collapsed summaries without changing raw details", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:5b:call-5b",
          name: "presentation_create",
          args: "with Example Deck",
          inputText: "with Example Deck",
        },
        { messageKey: "test-message", expanded: false, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    const summaryButton = container.querySelector("button.chat-tool-msg-summary");
    expect(summaryButton?.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe(
      "Example Deck",
    );

    render(
      renderToolCard(
        {
          id: "msg:5b:call-5b",
          name: "presentation_create",
          args: "with Example Deck",
          inputText: "with Example Deck",
        },
        { messageKey: "test-message", expanded: true, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    expect(container.querySelector(".chat-tool-card__block code")?.textContent).toBe(
      "with Example Deck",
    );
  });

  it("normalizes collapsed summary text for display only", () => {
    expect(formatCollapsedToolSummaryText("  with   Example Deck  ")).toBe("Example Deck");
    expect(formatCollapsedToolSummaryText("Example Deck")).toBe("Example Deck");
    expect(formatCollapsedToolSummaryText("   ")).toBeUndefined();
  });

  it("omits normalized tool details that repeat the label", () => {
    expect(formatDistinctCollapsedToolSummaryText("bash", "Bash")).toBeUndefined();
    expect(
      formatDistinctCollapsedToolSummaryText("heartbeat_respond", "Heartbeat Respond"),
    ).toBeUndefined();
    expect(formatDistinctCollapsedToolSummaryText("run openclaw doctor", "Bash")).toBe(
      "run openclaw doctor",
    );
  });

  it("keeps collapsed markdown previews bounded after display cleanup", () => {
    const preview = formatCollapsedToolPreviewText(`with ${"A".repeat(200)}`);

    expect(formatCollapsedToolPreviewText("First line\nSecond line")).toBe(
      "First line Second line",
    );
    expect(preview).toHaveLength(120);
    expect(preview?.startsWith("A")).toBe(true);
    expect(preview).not.toContain("with ");
    expect(formatCollapsedToolPreviewText(`${"A".repeat(119)}🚀tail`)).toBe("A".repeat(119));
  });

  it("bounds raw string argument fallbacks in collapsed summaries", () => {
    const container = document.createElement("div");
    const rawInput = `with ${"A".repeat(200)}`;
    render(
      renderToolCard(
        {
          id: "msg:5c:call-5c",
          name: "presentation_create",
          args: rawInput,
          inputText: rawInput,
        },
        { messageKey: "test-message", expanded: false, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    const labelText = container.querySelector(".chat-tool-msg-summary__label")?.textContent?.trim();
    expect(labelText).toHaveLength(120);
    expect(labelText?.startsWith("A")).toBe(true);
    expect(labelText).not.toContain("with ");
  });

  it("keeps raw details for legacy canvas tool output without rendering tool-row previews", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:view:7",
          name: "canvas_render",
          outputText: JSON.stringify({
            kind: "canvas",
            view: {
              backend: "canvas",
              id: "cv_counter",
              url: "/__openclaw__/canvas/documents/cv_counter/index.html",
              title: "Counter demo",
              preferred_height: 480,
            },
            presentation: {
              target: "tool_card",
            },
          }),
          preview: {
            kind: "canvas",
            surface: "assistant_message",
            render: "url",
            viewId: "cv_counter",
            title: "Counter demo",
            url: "/__openclaw__/canvas/documents/cv_counter/index.html",
            preferredHeight: 480,
          },
        },
        { messageKey: "test-message", expanded: true, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    const rawToggle = container.querySelector<HTMLButtonElement>(".chat-tool-card__raw-toggle");
    const rawBody = container.querySelector<HTMLElement>(".chat-tool-card__raw-body");

    expect(container.querySelector(".chat-tool-card__preview-frame")).toBeNull();
    expect(rawToggle).toBeInstanceOf(HTMLButtonElement);
    expect(rawBody).toBeInstanceOf(HTMLElement);
    expect(rawToggle!.classList).toContain("chat-inline-disclosure");
    expect(rawToggle!.classList).toContain("chat-tool-card__raw-toggle");
    expect(rawToggle!.textContent?.trim()).toBe("Raw details");
    expect(rawToggle!.getAttribute("aria-expanded")).toBe("false");
    expect(rawBody!.hidden).toBe(true);

    rawToggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(rawToggle!.getAttribute("aria-expanded")).toBe("true");
    expect(rawBody!.hidden).toBe(false);
    expect(rawBody!.querySelector(".chat-tool-card__block-label")).toBeNull();
    expect(rawBody!.querySelector("code.markdown-block-art")).toBeNull();
    expect(JSON.parse(rawBody!.querySelector("code")?.textContent ?? "{}")).toEqual({
      kind: "canvas",
      presentation: {
        target: "tool_card",
      },
      view: {
        backend: "canvas",
        id: "cv_counter",
        preferred_height: 480,
        title: "Counter demo",
        url: "/__openclaw__/canvas/documents/cv_counter/index.html",
      },
    });
  });

  it("marks expanded raw block-art output so QR whitespace uses block-art rendering", () => {
    const container = document.createElement("div");
    const blockArt = "  ▄▄▄▄▄▄▄  \n  █ ▄▄▄ █  \n  █▄▄▄▄▄█  ";
    render(
      renderToolCard(
        {
          id: "msg:view:block-art",
          name: "canvas_render",
          outputText: blockArt,
          preview: {
            kind: "canvas",
            surface: "assistant_message",
            render: "url",
            viewId: "qr_preview",
            url: "/__openclaw__/canvas/documents/qr_preview/index.html",
          },
        },
        { messageKey: "test-message", expanded: true, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    const rawToggle = container.querySelector<HTMLButtonElement>(".chat-tool-card__raw-toggle");
    rawToggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const code = container.querySelector("code.markdown-block-art");
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe(blockArt);
  });

  it("opens assistant-surface canvas payloads in the sidebar when explicitly requested", () => {
    const container = document.createElement("div");
    const onOpenSidebar = vi.fn();
    render(
      renderToolCard(
        {
          id: "msg:view:8",
          name: "canvas_render",
          outputText: JSON.stringify({
            kind: "canvas",
            view: {
              backend: "canvas",
              id: "cv_sidebar",
              url: "/__openclaw__/canvas/documents/cv_sidebar/index.html",
              title: "Player",
              preferred_height: 360,
            },
            presentation: {
              target: "assistant_message",
            },
          }),
          preview: {
            kind: "canvas",
            surface: "assistant_message",
            render: "url",
            viewId: "cv_sidebar",
            url: "/__openclaw__/canvas/documents/cv_sidebar/index.html",
            title: "Player",
            preferredHeight: 360,
          },
        },
        { messageKey: "test-message", expanded: true, onToggleExpanded: vi.fn(), onOpenSidebar },
      ),
      container,
    );

    const sidebarButton = container.querySelector<HTMLButtonElement>(".chat-tool-card__action-btn");
    expect(sidebarButton).toBeInstanceOf(HTMLButtonElement);
    expect([...sidebarButton!.classList]).toEqual(["chat-tool-card__action-btn"]);
    const tooltip = sidebarButton!.parentElement as HTMLElement & { content?: string };
    expect(tooltip.content).toBe(t("chat.toolCards.openDetails"));
    expect(sidebarButton!.getAttribute("aria-label")).toBe(t("chat.toolCards.openDetails"));
    sidebarButton!.click();

    const sidebar = requireFirstMockArg(onOpenSidebar, "sidebar open");
    expect(sidebar.kind).toBe("canvas");
    expect(sidebar.docId).toBe("cv_sidebar");
    expect(sidebar.entryUrl).toBe("/__openclaw__/canvas/documents/cv_sidebar/index.html");
  });

  it("opens ambiguous tool details with the same sidebar output", () => {
    const container = document.createElement("div");
    const onOpenSidebar = vi.fn();
    render(
      renderToolCard(
        {
          id: "msg:tool:full",
          name: "browser.open",
          outputText: "Opened page",
          messageId: "msg-tool-full",
        },
        { messageKey: "test-message", expanded: true, onToggleExpanded: vi.fn(), onOpenSidebar },
      ),
      container,
    );

    const sidebarButton = container.querySelector<HTMLButtonElement>(".chat-tool-card__action-btn");
    expect(sidebarButton).toBeInstanceOf(HTMLButtonElement);
    sidebarButton!.click();

    const sidebar = requireFirstMockArg(onOpenSidebar, "sidebar open");
    expect(sidebar).toEqual({
      kind: "markdown",
      content: "## Browser.open\n\n**Tool:** `browser.open`\n\n### Tool output\nOpened page",
      rawText: "Opened page",
    });
  });
});
