/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";

vi.mock("../markdown.ts", async (importOriginal) => await importOriginal());
vi.mock("../tool-display.ts", () => ({
  formatToolDetail: (display: { detail?: string }) => display.detail,
  resolveToolDisplay: ({ name, args }: { name: string; args?: unknown }) => {
    const argRecord =
      args && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : undefined;
    const labels: Record<string, string> = {
      sessions_spawn: "Sub-agent",
      skill_workshop: "Skill Workshop",
      web_search: "Web Search",
    };
    const detail =
      name === "skill_workshop" && typeof argRecord?.action === "string"
        ? argRecord.action
        : name === "read" && typeof argRecord?.path === "string"
          ? argRecord.path
          : undefined;
    return {
      name,
      label: labels[name] ?? name,
      icon: "zap",
      detail,
    };
  },
}));

import {
  buildMcpAppHostCapabilities,
  resolveMcpAppSandboxUrl,
} from "../../../components/mcp-app-view.ts";
import { t } from "../../../i18n/index.ts";
import {
  formatDistinctCollapsedToolSummaryText,
  formatCollapsedToolPreviewText,
  formatCollapsedToolSummaryText,
  isToolErrorOutput,
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
  it("advertises the CSP actually applied to MCP Apps", () => {
    expect(
      buildMcpAppHostCapabilities({ connectDomains: ["https://api.example.com"] }),
    ).toMatchObject({
      sandbox: { csp: { connectDomains: ["https://api.example.com"] } },
    });
    expect(buildMcpAppHostCapabilities()).toMatchObject({ sandbox: { csp: {} } });
  });

  it("accepts only the dedicated-origin MCP App sandbox endpoint", () => {
    expect(
      resolveMcpAppSandboxUrl(
        "/mcp-app-sandbox?csp=abc",
        8444,
        undefined,
        "wss://gateway.example:8443/openclaw",
        "https://gateway.example:8443",
      ),
    ).toBe("https://gateway.example:8444/mcp-app-sandbox?csp=abc");
    expect(
      resolveMcpAppSandboxUrl(
        "/mcp-app-sandbox",
        18790,
        "https://apps.example.com",
        "wss://gateway.example",
        "https://gateway.example",
      ),
    ).toBe("https://apps.example.com/mcp-app-sandbox");
    expect(() =>
      resolveMcpAppSandboxUrl(
        "https://attacker.example/mcp-app-sandbox",
        8444,
        undefined,
        "wss://gateway.example:8443/openclaw",
        "https://gateway.example:8443",
      ),
    ).toThrow("MCP App sandbox URL is invalid");
    expect(() =>
      resolveMcpAppSandboxUrl(
        "data:text/html;base64,cHJveHk=",
        8444,
        undefined,
        "wss://gateway.example:8443/openclaw",
        "https://gateway.example:8443",
      ),
    ).toThrow("MCP App sandbox URL is invalid");
    expect(() =>
      resolveMcpAppSandboxUrl(
        "/mcp-app-sandbox",
        8443,
        undefined,
        "wss://gateway.example:8443/openclaw",
        "https://gateway.example:8443",
      ),
    ).toThrow("MCP App sandbox URL is invalid");
    expect(() =>
      resolveMcpAppSandboxUrl(
        "/mcp-app-sandbox",
        8444,
        "https://gateway.example:8443",
        "wss://gateway.example:8443/openclaw",
        "https://control.example",
      ),
    ).toThrow("MCP App sandbox URL is invalid");
  });

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
        { expanded: false, onToggleExpanded: toggle },
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
        { expanded: true, onToggleExpanded: toggle },
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
    expect(
      blocks.map((block) => block.querySelector(".chat-tool-card__block-label")?.textContent),
    ).toEqual(["Tool output"]);
    expect(blocks[0]?.querySelector("code")?.textContent).toBe("Opened page");
  });

  it("renders multi-file patch headers, changed rows, and raw output together", () => {
    const container = document.createElement("div");
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
        { expanded: true, onToggleExpanded: vi.fn() },
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

    const rawToggle = container.querySelector<HTMLButtonElement>(".chat-tool-card__raw-toggle");
    expect(rawToggle?.textContent?.trim()).toBe("Raw details");
    rawToggle?.click();
    expect(container.querySelector(".chat-tool-card__raw-body code")?.textContent).toBe(
      "Applied patch",
    );
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
        card: { live: true },
        runActive: true,
        verb: "running",
        label: "Attempted changes",
        hasStat: false,
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
        expect(container.querySelector(".chat-tool-row__badge")?.textContent === "failed").toBe(
          state.failed,
        );
        expect(container.querySelector(".chat-tool-msg-summary--error") !== null).toBe(
          state.failed,
        );
      }
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
        { expanded: true, onToggleExpanded: vi.fn() },
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
        { expanded: true, onToggleExpanded: vi.fn() },
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
        { expanded: false, onToggleExpanded: vi.fn() },
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
        { expanded: false, onToggleExpanded: vi.fn() },
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
        { expanded: false, onToggleExpanded: vi.fn() },
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
        { expanded: true, onToggleExpanded: vi.fn() },
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
        { expanded: false, onToggleExpanded: vi.fn() },
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
        { expanded: true, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    const rawToggle = container.querySelector<HTMLButtonElement>(".chat-tool-card__raw-toggle");
    const rawBody = container.querySelector<HTMLElement>(".chat-tool-card__raw-body");

    expect(container.querySelector(".chat-tool-card__preview-frame")).toBeNull();
    expect(rawToggle).toBeInstanceOf(HTMLButtonElement);
    expect(rawBody).toBeInstanceOf(HTMLElement);
    expect([...rawToggle!.classList]).toEqual(["chat-tool-card__raw-toggle"]);
    expect(rawToggle!.textContent?.trim()).toBe("Raw details");
    expect(rawToggle!.getAttribute("aria-expanded")).toBe("false");
    expect(rawBody!.hidden).toBe(true);

    rawToggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(rawToggle!.getAttribute("aria-expanded")).toBe("true");
    expect(rawBody!.hidden).toBe(false);
    expect(rawBody!.querySelector(".chat-tool-card__block-label")?.textContent).toBe("Tool output");
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
        { expanded: true, onToggleExpanded: vi.fn() },
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
        { expanded: true, onToggleExpanded: vi.fn(), onOpenSidebar },
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
  describe("isToolErrorOutput", () => {
    it("flags JSON payloads that carry a top-level error string", () => {
      expect(
        isToolErrorOutput(
          JSON.stringify({
            error: "missing_brave_api_key",
            message: "BRAVE_API_KEY is not configured",
            provider: "brave",
          }),
        ),
      ).toBe(true);
    });

    it("flags JSON payloads that carry a top-level isError flag", () => {
      expect(
        isToolErrorOutput(
          JSON.stringify({
            isError: true,
            content: [{ type: "text", text: "Tool error: boom" }],
          }),
        ),
      ).toBe(true);
      expect(
        isToolErrorOutput(
          JSON.stringify({
            is_error: true,
            content: [{ type: "text", text: "Tool error: boom" }],
          }),
        ),
      ).toBe(true);
    });

    it("flags 'Tool not found' bodies regardless of trailing punctuation or case", () => {
      expect(isToolErrorOutput("Tool not found")).toBe(true);
      expect(isToolErrorOutput("  tool not found.  ")).toBe(true);
      expect(isToolErrorOutput("TOOL NOT FOUND")).toBe(true);
    });

    it("flags JSON payloads with top-level failure statuses", () => {
      expect(isToolErrorOutput(JSON.stringify({ status: "error" }))).toBe(true);
      expect(isToolErrorOutput(JSON.stringify({ status: "failed" }))).toBe(true);
      expect(isToolErrorOutput(JSON.stringify({ status: "timeout" }))).toBe(true);
      expect(isToolErrorOutput(JSON.stringify({ status: "completed" }))).toBe(false);
      expect(isToolErrorOutput(JSON.stringify({ status: "ok" }))).toBe(false);
    });

    it("does not flag successful payloads or strings without a tool error signal", () => {
      expect(isToolErrorOutput(undefined)).toBe(false);
      expect(isToolErrorOutput("")).toBe(false);
      expect(isToolErrorOutput("Opened page")).toBe(false);
      expect(
        isToolErrorOutput(
          JSON.stringify({ isError: false, result: "ok", error: "no validation errors" }),
        ),
      ).toBe(false);
      expect(isToolErrorOutput(JSON.stringify({ result: "ok", error: null }))).toBe(false);
      expect(isToolErrorOutput(JSON.stringify({ result: "ok", error: "" }))).toBe(false);
      expect(isToolErrorOutput(JSON.stringify({ result: "ok" }))).toBe(false);
      expect(isToolErrorOutput("{ not really json }")).toBe(false);
    });
  });

  it("renders an error summary without a redundant Error badge", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:err:1",
          name: "web_search",
          args: { query: "python stable version" },
          inputText: '{\n  "query": "python stable version"\n}',
          outputText: JSON.stringify({
            error: "missing_brave_api_key",
            message: "BRAVE_API_KEY is not configured",
          }),
        },
        { expanded: true, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    expect(container.textContent).toContain("Tool error");
    expect(container.textContent).not.toMatch(/\bTool output\b/);
    const summaryButton = container.querySelector("button.chat-tool-msg-summary");
    expect(summaryButton?.classList.contains("chat-tool-msg-summary--error")).toBe(true);
    expect(summaryButton?.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe(
      "Tool error",
    );
    expect(container.querySelector(".chat-tool-msg-summary__error-badge")).toBeNull();
    const expandedCard = container.querySelector(".chat-tool-card");
    expect(expandedCard?.classList.contains("chat-tool-card--error")).toBe(true);
    expect(container.querySelector(".chat-tool-card__status-badge")).toBeNull();
    expect(
      Array.from(container.querySelectorAll(".chat-tool-card__block-label")).map(
        (label) => label.textContent,
      ),
    ).toContain("Tool error");
  });

  it("renders a Tool error label when output has a status-only error payload", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:err:status-only",
          name: "sessions_spawn",
          outputText: JSON.stringify({ status: "error" }),
        },
        { expanded: true, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    expect(container.textContent).toContain("Tool error");
    expect(container.textContent).not.toMatch(/\bTool output\b/);
    expect(container.querySelector(".chat-tool-msg-summary--error")).not.toBeNull();
    expect(container.querySelector(".chat-tool-card--error")).not.toBeNull();
  });

  it("renders a Tool error label when output is the literal 'Tool not found'", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:err:2",
          name: "Unknown",
          outputText: "Tool not found",
        },
        { expanded: false, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    expect(container.textContent).toContain("Tool error");
    expect(container.textContent).not.toMatch(/\bTool output\b/);
    const summaryButton = container.querySelector("button.chat-tool-msg-summary");
    expect(summaryButton?.classList.contains("chat-tool-msg-summary--error")).toBe(true);
    expect(container.querySelector(".chat-tool-msg-summary__error-badge")).toBeNull();
  });

  it("renders a Tool error label when the tool card has an explicit error flag", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:err:explicit",
          name: "lookup",
          outputText: "lookup failed",
          isError: true,
        },
        { expanded: true, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    expect(container.textContent).toContain("Tool error");
    expect(container.textContent).not.toMatch(/\bTool output\b/);
    expect(container.querySelector(".chat-tool-msg-summary--error")).not.toBeNull();
    expect(container.querySelector(".chat-tool-card--error")).not.toBeNull();
  });

  it("renders a plain error detail when a failed tool has no output", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:err:no-output",
          name: "lookup",
          isError: true,
        },
        { expanded: true, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    expect(container.querySelector(".chat-tool-card__status-badge")).toBeNull();
    expect(container.querySelector(".chat-tool-card__block-label")?.textContent).toBe("Tool error");
    expect(container.querySelector(".chat-tool-card__block-content")?.textContent).toBe(
      "No output — tool failed.",
    );
  });

  it("respects an explicit success flag even when the payload looks like an error", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:err:status-false",
          name: "web_search",
          outputText: JSON.stringify({
            error: "missing_brave_api_key",
          }),
          isError: false,
        },
        { expanded: false, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    expect(container.textContent).toContain("Web Search");
    expect(container.textContent).not.toContain("Tool error");
    expect(container.querySelector(".chat-tool-msg-summary--error")).toBeNull();
    expect(container.querySelector(".chat-tool-msg-summary__error-badge")).toBeNull();
  });

  it("keeps Tool output labelling for successful results", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:ok:1",
          name: "browser.open",
          outputText: "Opened page",
        },
        { expanded: true, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    expect(container.textContent).toContain("Tool output");
    expect(container.textContent).not.toContain("Tool error");
    expect(container.querySelector(".chat-tool-msg-summary--error")).toBeNull();
    expect(container.querySelector(".chat-tool-card__status-badge")).toBeNull();
  });
  it("does not add a full-message request for ambiguous tool details", () => {
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
        {
          expanded: true,
          sessionKey: "main",
          agentId: "work",
          onToggleExpanded: vi.fn(),
          onOpenSidebar,
        },
      ),
      container,
    );

    const sidebarButton = container.querySelector<HTMLButtonElement>(".chat-tool-card__action-btn");
    expect(sidebarButton).toBeInstanceOf(HTMLButtonElement);
    sidebarButton!.click();

    const sidebar = requireFirstMockArg(onOpenSidebar, "sidebar open");
    expect(sidebar.kind).toBe("markdown");
    expect(sidebar.fullMessageRequest).toBeUndefined();
  });
});
