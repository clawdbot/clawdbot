// Browser tests cover chrome mcp plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChromeMcpDocumentUnavailableError,
  clickChromeMcpCoords,
  clickChromeMcpElement,
  closeChromeMcpTab,
  closeChromeMcpSession,
  countChromeMcpTabs,
  decodeChromeMcpStderrTail,
  dragChromeMcpElement,
  ensureChromeMcpAvailable,
  evaluateChromeMcpScript,
  fillChromeMcpElement,
  fillChromeMcpForm,
  hoverChromeMcpElement,
  listChromeMcpTabs,
  navigateChromeMcpPage,
  openChromeMcpTab,
  parseChromeMcpUnixProcessListForTest,
  resolveChromeMcpNavigateCallTimeoutMs,
  resetChromeMcpSessionsForTest,
  setChromeMcpProcessCleanupDepsForTest,
  setChromeMcpSessionFactoryForTest,
  takeChromeMcpScreenshot,
  takeChromeMcpSnapshot,
  uploadChromeMcpFile,
  withChromeMcpDocument,
} from "./chrome-mcp.js";

type ToolCall = {
  name: string;
  arguments?: Record<string, unknown>;
};
type ToolCallMock = {
  mock: {
    calls: Array<[ToolCall, unknown?, { signal?: AbortSignal; timeout?: number }?]>;
  };
};

function createSdkTimeoutCallTool() {
  return vi.fn(
    async (_call: ToolCall, _resultSchema?: unknown, options?: { timeout?: number }) =>
      await new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new McpError(ErrorCode.RequestTimeout, "Request timed out")),
          options?.timeout,
        );
      }),
  );
}

function fakeListPagesResult() {
  return {
    content: [{ type: "text", text: "## Pages\n1: https://example.com [selected]" }],
  };
}

type ChromeMcpSessionFactory = Exclude<
  Parameters<typeof setChromeMcpSessionFactoryForTest>[0],
  null
>;
type ChromeMcpSession = Awaited<ReturnType<ChromeMcpSessionFactory>>;
const FAKE_TARGET_1 = "chrome-mcp:000000000001:1";
const FAKE_TARGET_2 = "chrome-mcp:000000000001:2";
const FAKE_TARGET_3 = "chrome-mcp:000000000001:3";
const FAKE_REF = "mcp-ref:000000000001:1";

function processSnapshot(pid: number, ppid: number, identity = `start-${pid}`) {
  return { pid, ppid, identity };
}

function createFakeSession(): ChromeMcpSession {
  let currentUrl =
    "https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session";
  let createdPageOpen = false;
  const readUrlArg = (value: unknown, fallback: string) =>
    typeof value === "string" && value.trim() ? value : fallback;
  const callTool = vi.fn(async ({ name, arguments: args }: ToolCall) => {
    if (name === "list_pages") {
      const pageLines = [
        "## Pages",
        `1: ${currentUrl} [selected]`,
        "2: https://github.com/openclaw/openclaw/pull/45318",
      ];
      if (createdPageOpen) {
        pageLines.push(`3: ${currentUrl}`);
      }
      return {
        content: [
          {
            type: "text",
            text: pageLines.join("\n"),
          },
        ],
      };
    }
    if (name === "new_page") {
      currentUrl = readUrlArg(args?.url, "about:blank");
      createdPageOpen = true;
      return {
        content: [
          {
            type: "text",
            text: [
              "## Pages",
              "1: https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session",
              "2: https://github.com/openclaw/openclaw/pull/45318",
              `3: ${currentUrl} [selected]`,
            ].join("\n"),
          },
        ],
      };
    }
    if (name === "navigate_page") {
      currentUrl = readUrlArg(args?.url, currentUrl);
      return { content: [{ type: "text", text: "navigated" }] };
    }
    if (name === "evaluate_script") {
      return {
        content: [
          {
            type: "text",
            text: "```json\n123\n```",
          },
        ],
      };
    }
    if (name === "take_screenshot") {
      const filePath = typeof args?.filePath === "string" ? args.filePath : undefined;
      const format = args?.format === "jpeg" ? "jpeg" : "png";
      if (!filePath) {
        throw new Error("missing filePath");
      }
      await fs.writeFile(`${filePath}.${format}`, Buffer.from(`screenshot:${format}`));
      return { content: [{ type: "text", text: `Saved screenshot to ${filePath}.${format}.` }] };
    }
    throw new Error(`unexpected tool ${name}`);
  });

  return {
    client: {
      callTool,
      listTools: vi.fn().mockResolvedValue({ tools: [{ name: "list_pages" }] }),
      close: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
    },
    transport: {
      pid: 123,
    },
    ready: Promise.resolve(),
    // Legacy cases exercise unrelated call plumbing. Seed one real-shaped
    // process-scoped routing generation so they stay terse.
    routing: {
      sessionNonce: "000000000001",
      withOperationLock: async <T>(operation: () => Promise<T>) => await operation(),
      targetIdByPageId: new Map([
        [1, FAKE_TARGET_1],
        [2, FAKE_TARGET_2],
        [3, FAKE_TARGET_3],
      ]),
      nextTargetHandleId: 4,
      snapshotRefById: new Map([[FAKE_REF, { targetId: FAKE_TARGET_1, uid: "btn-1" }]]),
      nextSnapshotRefId: 2,
    },
  } as unknown as ChromeMcpSession;
}

function createToolErrorSession(message: string): ChromeMcpSession {
  const callTool = vi.fn(async () => ({
    isError: true,
    content: [{ type: "text", text: message }],
  }));
  return {
    client: {
      callTool,
      listTools: vi.fn().mockResolvedValue({ tools: [{ name: "list_pages" }] }),
      close: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
    },
    transport: {
      pid: 123,
    },
    ready: Promise.resolve(),
  } as unknown as ChromeMcpSession;
}

type SessionPage = { id: number; url: string; selected?: boolean };

function createPageSession(params: {
  pages: SessionPage[];
  pid: number;
  onTool?: (call: ToolCall) => unknown;
}): ChromeMcpSession {
  const callTool = vi.fn(async (call: ToolCall) => {
    const custom = await params.onTool?.(call);
    if (custom !== undefined) {
      return custom;
    }
    if (call.name === "list_pages") {
      return {
        structuredContent: {
          pages: params.pages.map(({ id, url, selected }) => ({ id, url, selected })),
        },
      };
    }
    if (call.name === "evaluate_script") {
      return { content: [{ type: "text", text: "```json\nnull\n```" }] };
    }
    throw new Error(`unexpected tool ${call.name}`);
  });
  return {
    client: {
      callTool,
      listTools: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn(),
    },
    transport: { pid: params.pid },
    ready: Promise.resolve(),
  } as unknown as ChromeMcpSession;
}

describe("chrome MCP page parsing", () => {
  beforeEach(async () => {
    await resetChromeMcpSessionsForTest();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("keeps document-bound evaluations on one pinned target and raw snapshot uid", async () => {
    const session = createPageSession({
      pid: 139,
      pages: [{ id: 1, url: "https://example.com" }],
      onTool: (call) => {
        if (call.name === "take_snapshot") {
          return {
            structuredContent: {
              snapshot: { id: "7_0", role: "RootWebArea", name: "Example" },
            },
          };
        }
        if (call.name === "evaluate_script") {
          return { content: [{ type: "text", text: '```json\n"ok"\n```' }] };
        }
        return undefined;
      },
    });
    setChromeMcpSessionFactoryForTest(async () => session);
    const targetId = (await listChromeMcpTabs("chrome-live"))[0]?.targetId ?? "";

    await expect(
      withChromeMcpDocument({ profileName: "chrome-live", targetId }, async (document) => [
        await document.evaluate("(root) => root.ownerDocument.location.href"),
        await document.evaluate("(root) => root.textContent"),
      ]),
    ).resolves.toEqual(["ok", "ok"]);

    const calls = (session.client.callTool as unknown as ToolCallMock).mock.calls.map(
      ([call]) => call,
    );
    expect(calls.map((call) => call.name)).toEqual([
      "list_pages",
      "take_snapshot",
      "evaluate_script",
      "evaluate_script",
    ]);
    expect(calls.at(-1)?.arguments).toMatchObject({ pageId: 1, args: ["7_0"] });
  });

  it("brands a stale document uid so waits can recapture after navigation", async () => {
    const session = createPageSession({
      pid: 139,
      pages: [{ id: 1, url: "https://example.com" }],
      onTool: (call) => {
        if (call.name === "take_snapshot") {
          return {
            structuredContent: { snapshot: { id: "8_0", role: "RootWebArea" } },
          };
        }
        if (call.name === "evaluate_script") {
          return {
            isError: true,
            content: [
              { type: "text", text: 'Element with uid "8_0" no longer exists on the page.' },
            ],
          };
        }
        return undefined;
      },
    });
    setChromeMcpSessionFactoryForTest(async () => session);
    const targetId = (await listChromeMcpTabs("chrome-live"))[0]?.targetId ?? "";

    await expect(
      withChromeMcpDocument({ profileName: "chrome-live", targetId }, (document) =>
        document.evaluate("(root) => root.ownerDocument.location.href"),
      ),
    ).rejects.toBeInstanceOf(ChromeMcpDocumentUnavailableError);
  });

  it.each([
    ["take_snapshot", "Execution context was destroyed, most likely because of a navigation."],
    ["evaluate_script", "Protocol error: Frame was detached."],
  ])("brands navigation failure from %s for document recapture", async (failedTool, message) => {
    const session = createPageSession({
      pid: 139,
      pages: [{ id: 1, url: "https://example.com" }],
      onTool: (call) => {
        if (call.name === failedTool) {
          return { isError: true, content: [{ type: "text", text: message }] };
        }
        if (call.name === "take_snapshot") {
          return {
            structuredContent: { snapshot: { id: "9_0", role: "RootWebArea" } },
          };
        }
        return undefined;
      },
    });
    setChromeMcpSessionFactoryForTest(async () => session);
    const targetId = (await listChromeMcpTabs("chrome-live"))[0]?.targetId ?? "";

    await expect(
      withChromeMcpDocument({ profileName: "chrome-live", targetId }, (document) =>
        document.evaluate("(root) => root.ownerDocument.location.href"),
      ),
    ).rejects.toBeInstanceOf(ChromeMcpDocumentUnavailableError);
  });

  it("binds macOS ancestry, start time, and executable command in one snapshot row", () => {
    expect(
      parseChromeMcpUnixProcessListForTest(
        "  123   1 Fri Jul 11 15:00:00 2026 /Applications/Google Chrome --remote-debugging-port=0",
        "darwin",
      ),
    ).toEqual([
      {
        pid: 123,
        ppid: 1,
        identity:
          "darwin:Fri Jul 11 15:00:00 2026|/Applications/Google Chrome --remote-debugging-port=0",
      },
    ]);
  });

  it("parses list_pages text responses when structuredContent is missing", async () => {
    const factory: ChromeMcpSessionFactory = async () => createFakeSession();
    setChromeMcpSessionFactoryForTest(factory);

    const tabs = await listChromeMcpTabs("chrome-live");

    expect(tabs).toEqual([
      {
        targetId: FAKE_TARGET_1,
        title: "",
        url: "https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session",
        type: "page",
      },
      {
        targetId: FAKE_TARGET_2,
        title: "",
        url: "https://github.com/openclaw/openclaw/pull/45318",
        type: "page",
      },
    ]);
  });

  it("expires process-scoped targets when the MCP subprocess changes", async () => {
    let factoryCalls = 0;
    let evaluateCalls = 0;
    setChromeMcpSessionFactoryForTest(async () => {
      factoryCalls += 1;
      return createPageSession({
        pid: 120 + factoryCalls,
        pages: [
          {
            id: 1,
            url: factoryCalls === 1 ? "https://a.example" : "https://decoy.example",
          },
        ],
        onTool: (call) => {
          if (call.name === "evaluate_script") {
            evaluateCalls += 1;
          }
          return undefined;
        },
      });
    });

    const oldTargetId = (await listChromeMcpTabs("chrome-live"))[0]?.targetId;
    expect(oldTargetId).toMatch(/^chrome-mcp:/);
    await closeChromeMcpSession("chrome-live");

    await expect(
      evaluateChromeMcpScript({
        profileName: "chrome-live",
        targetId: oldTargetId ?? "",
        fn: "() => document.body.dataset.marker",
      }),
    ).rejects.toThrow(/tab not found/);
    expect(evaluateCalls).toBe(0);

    const freshTargetId = (await listChromeMcpTabs("chrome-live"))[0]?.targetId;
    expect(freshTargetId).toMatch(/^chrome-mcp:/);
    expect(freshTargetId).not.toBe(oldTargetId);
  });

  it("closes the exact cached client before replacing a session whose process exited", async () => {
    let factoryCalls = 0;
    const sessions: ChromeMcpSession[] = [];
    setChromeMcpSessionFactoryForTest(async () => {
      factoryCalls += 1;
      const session = createPageSession({
        pid: 200 + factoryCalls,
        pages: [{ id: 1, url: "https://example.com" }],
      });
      sessions.push(session);
      return session;
    });

    await listChromeMcpTabs("chrome-live");
    const first = sessions[0];
    if (!first) {
      throw new Error("Expected first Chrome MCP session");
    }
    (first.transport as { pid: number | null }).pid = null;

    await listChromeMcpTabs("chrome-live");

    expect(factoryCalls).toBe(2);
    expect((first.client.close as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("preserves a healthy cached session when an ephemeral probe is already cancelled", async () => {
    const session = createFakeSession();
    const factory = vi.fn(async () => session);
    setChromeMcpSessionFactoryForTest(factory);
    await listChromeMcpTabs("chrome-live");
    const ctrl = new AbortController();
    ctrl.abort(new Error("probe cancelled"));

    await expect(
      countChromeMcpTabs("chrome-live", undefined, {
        ephemeral: true,
        signal: ctrl.signal,
      }),
    ).rejects.toThrow("probe cancelled");
    await expect(listChromeMcpTabs("chrome-live")).resolves.toHaveLength(2);

    expect(factory).toHaveBeenCalledOnce();
    expect((session.client.close as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("does not invoke the session factory for a pre-aborted ephemeral probe", async () => {
    const factory = vi.fn(async () => createFakeSession());
    setChromeMcpSessionFactoryForTest(factory);
    const ctrl = new AbortController();
    ctrl.abort(new Error("probe cancelled"));

    await expect(
      countChromeMcpTabs("chrome-live", undefined, {
        ephemeral: true,
        signal: ctrl.signal,
      }),
    ).rejects.toThrow("probe cancelled");

    expect(factory).not.toHaveBeenCalled();
  });

  it("keeps a target stable within one MCP subprocess as its URL and list order change", async () => {
    const pages: SessionPage[] = [
      { id: 1, url: "https://a.example/one" },
      { id: 2, url: "https://b.example" },
    ];
    let evaluatedPageId: unknown;
    const session = createPageSession({
      pid: 130,
      pages,
      onTool: (call) => {
        if (call.name === "evaluate_script") {
          evaluatedPageId = call.arguments?.pageId;
        }
        return undefined;
      },
    });
    setChromeMcpSessionFactoryForTest(async () => session);

    const firstTargetId = (await listChromeMcpTabs("chrome-live"))[0]?.targetId ?? "";
    pages[0] = { id: 1, url: "https://a.example/two" };
    pages.reverse();
    const relisted = await listChromeMcpTabs("chrome-live");
    expect(relisted.find((tab) => tab.url.endsWith("/two"))?.targetId).toBe(firstTargetId);

    await evaluateChromeMcpScript({
      profileName: "chrome-live",
      targetId: firstTargetId,
      fn: "() => document.URL",
    });
    expect(evaluatedPageId).toBe(1);
    expect(
      (session.client.callTool as unknown as ToolCallMock).mock.calls.filter(
        ([call]) => call.name === "list_pages",
      ),
    ).toHaveLength(2);
  });

  it("routes an opaque target to its numeric page for close without replay", async () => {
    let closedPageId: unknown;
    const session = createPageSession({
      pid: 131,
      pages: [
        { id: 1, url: "https://a.example" },
        { id: 2, url: "https://b.example" },
      ],
      onTool: (call) => {
        if (call.name === "close_page") {
          closedPageId = call.arguments?.pageId;
          return { content: [{ type: "text", text: "closed" }] };
        }
        return undefined;
      },
    });
    setChromeMcpSessionFactoryForTest(async () => session);
    const targetId = (await listChromeMcpTabs("chrome-live"))[1]?.targetId ?? "";

    await closeChromeMcpTab("chrome-live", targetId);

    expect(closedPageId).toBe(2);
    const calls = (session.client.callTool as unknown as ToolCallMock).mock.calls.map(
      ([call]) => call.name,
    );
    expect(calls).toEqual(["list_pages", "close_page"]);
  });

  it("retires a closed target and issues a new handle when Chrome reuses its page id", async () => {
    const pages: SessionPage[] = [
      { id: 1, url: "https://a.example" },
      { id: 2, url: "https://b.example" },
    ];
    let clickCalls = 0;
    const session = createPageSession({
      pid: 132,
      pages,
      onTool: (call) => {
        if (call.name === "take_snapshot") {
          return {
            structuredContent: {
              snapshot: { id: "uid-b", role: "button", name: "Run B" },
            },
          };
        }
        if (call.name === "close_page") {
          const index = pages.findIndex((page) => page.id === call.arguments?.pageId);
          if (index >= 0) {
            pages.splice(index, 1);
          }
          return { content: [{ type: "text", text: "closed" }] };
        }
        if (call.name === "click") {
          clickCalls += 1;
          return { content: [{ type: "text", text: "clicked" }] };
        }
        return undefined;
      },
    });
    setChromeMcpSessionFactoryForTest(async () => session);

    const oldTarget = (await listChromeMcpTabs("chrome-live"))[1]?.targetId ?? "";
    const snapshot = await takeChromeMcpSnapshot({
      profileName: "chrome-live",
      targetId: oldTarget,
    });
    await closeChromeMcpTab("chrome-live", oldTarget);
    await expect(
      clickChromeMcpElement({
        profileName: "chrome-live",
        targetId: oldTarget,
        uid: snapshot.id ?? "",
      }),
    ).rejects.toThrow(/tab not found/i);
    expect(clickCalls).toBe(0);

    pages.push({ id: 2, url: "https://replacement.example" });
    const replacement = (await listChromeMcpTabs("chrome-live")).find(
      (tab) => tab.url === "https://replacement.example",
    );
    expect(replacement?.targetId).not.toBe(oldTarget);
  });

  it("fails closed for duplicate numeric page ids", async () => {
    setChromeMcpSessionFactoryForTest(async () =>
      createPageSession({
        pid: 131,
        pages: [
          { id: 1, url: "https://a.example" },
          { id: 1, url: "https://b.example" },
        ],
      }),
    );

    await expect(listChromeMcpTabs("chrome-live")).rejects.toThrow(/duplicate numeric page id 1/);
  });

  it("serializes compound operations on one MCP session", async () => {
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let listCalls = 0;
    const session = createPageSession({
      pid: 132,
      pages: [{ id: 1, url: "https://a.example" }],
      onTool: async (call) => {
        if (call.name !== "list_pages") {
          return undefined;
        }
        listCalls += 1;
        if (listCalls === 1) {
          markFirstStarted();
          await firstGate;
        }
        return undefined;
      },
    });
    setChromeMcpSessionFactoryForTest(async () => session);

    const first = listChromeMcpTabs("chrome-live");
    await firstStarted;
    const second = listChromeMcpTabs("chrome-live");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(listCalls).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(listCalls).toBe(2);
  });

  it("fails queued work closed after transport loss and reconnects on the next call", async () => {
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let factoryCalls = 0;
    let firstSession: ChromeMcpSession | undefined;
    setChromeMcpSessionFactoryForTest(async () => {
      factoryCalls += 1;
      const session = createPageSession({
        pid: 135 + factoryCalls,
        pages: [{ id: 1, url: `https://session-${factoryCalls}.example` }],
        onTool: async (call) => {
          if (factoryCalls === 1 && call.name === "list_pages") {
            markFirstStarted();
            await firstGate;
            throw new Error("connection reset after list dispatch");
          }
          return undefined;
        },
      });
      firstSession ??= session;
      return session;
    });

    const first = listChromeMcpTabs("chrome-live");
    const firstExpectation = expect(first).rejects.toThrow(/connection reset after list dispatch/);
    await firstStarted;
    const queued = listChromeMcpTabs("chrome-live");
    const queuedExpectation = expect(queued).rejects.toThrow(/changed before the operation/);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    releaseFirst();

    await firstExpectation;
    await queuedExpectation;
    await expect(listChromeMcpTabs("chrome-live")).resolves.toEqual([
      expect.objectContaining({ url: "https://session-2.example" }),
    ]);
    expect(factoryCalls).toBe(2);
    if (!firstSession) {
      throw new Error("Expected the first Chrome MCP session to be created");
    }
    const firstCalls = (firstSession.client.callTool as unknown as ToolCallMock).mock.calls;
    expect(firstCalls.filter(([call]) => call.name === "list_pages")).toHaveLength(1);
  });

  it("stops a session without waiting for a hung active operation", async () => {
    let markListStarted!: () => void;
    let rejectList!: (reason: Error) => void;
    const listStarted = new Promise<void>((resolve) => {
      markListStarted = resolve;
    });
    const pendingList = new Promise<never>((_resolve, reject) => {
      rejectList = reject;
    });
    const session = createPageSession({
      pid: 138,
      pages: [{ id: 1, url: "https://a.example" }],
      onTool: async (call) => {
        if (call.name === "list_pages") {
          markListStarted();
          return await pendingList;
        }
        return undefined;
      },
    });
    const close = vi.fn(async () => {
      rejectList(new Error("session closed by explicit stop"));
    });
    session.client.close = close as typeof session.client.close;
    setChromeMcpSessionFactoryForTest(async () => session);

    const active = listChromeMcpTabs("chrome-live");
    const activeExpectation = expect(active).rejects.toThrow(/session closed by explicit stop/);
    await listStarted;

    await expect(closeChromeMcpSession("chrome-live")).resolves.toBe(true);
    await activeExpectation;
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not let work queued before stop recreate the session", async () => {
    let markListStarted!: () => void;
    let releaseList!: () => void;
    const listStarted = new Promise<void>((resolve) => {
      markListStarted = resolve;
    });
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    let factoryCalls = 0;
    let listCalls = 0;
    setChromeMcpSessionFactoryForTest(async () => {
      factoryCalls += 1;
      return createPageSession({
        pid: 139,
        pages: [{ id: 1, url: "https://a.example" }],
        onTool: async (call) => {
          if (call.name === "list_pages") {
            listCalls += 1;
            if (listCalls === 1) {
              markListStarted();
              await listGate;
            }
          }
          return undefined;
        },
      });
    });

    const active = listChromeMcpTabs("chrome-live");
    await listStarted;
    const queued = listChromeMcpTabs("chrome-live");
    const queuedExpectation = expect(queued).rejects.toThrow(/changed before the operation/);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    await expect(closeChromeMcpSession("chrome-live")).resolves.toBe(true);
    releaseList();
    await active;
    await queuedExpectation;
    expect(factoryCalls).toBe(1);
    expect(listCalls).toBe(1);
  });

  it("fails queued work closed while a transport failure is closing", async () => {
    let markListStarted!: () => void;
    let releaseList!: () => void;
    let markCloseStarted!: () => void;
    let releaseClose!: () => void;
    const listStarted = new Promise<void>((resolve) => {
      markListStarted = resolve;
    });
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const closeStarted = new Promise<void>((resolve) => {
      markCloseStarted = resolve;
    });
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let factoryCalls = 0;
    const session = createPageSession({
      pid: 141,
      pages: [{ id: 1, url: "https://a.example" }],
      onTool: async (call) => {
        if (call.name === "list_pages") {
          markListStarted();
          await listGate;
          throw new Error("transport failed before stop");
        }
        return undefined;
      },
    });
    const close = vi.fn(async () => {
      markCloseStarted();
      await closeGate;
    });
    session.client.close = close as typeof session.client.close;
    setChromeMcpSessionFactoryForTest(async () => {
      factoryCalls += 1;
      return session;
    });

    const active = listChromeMcpTabs("chrome-live");
    void active.catch(() => {});
    await listStarted;
    const queued = listChromeMcpTabs("chrome-live");
    void queued.catch(() => {});
    releaseList();
    await closeStarted;

    let explicitCloseSettled = false;
    const explicitClose = closeChromeMcpSession("chrome-live").then((closed) => {
      explicitCloseSettled = true;
      return closed;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(explicitCloseSettled).toBe(false);
    releaseClose();
    await expect(active).rejects.toThrow(/transport failed before stop/);
    await expect(queued).rejects.toThrow(/changed before the operation/);
    await expect(explicitClose).resolves.toBe(true);
    expect(factoryCalls).toBe(1);
  });

  it("cancels queued admission before dispatch on abort or timeout", async () => {
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let listCalls = 0;
    const session = createPageSession({
      pid: 138,
      pages: [{ id: 1, url: "https://a.example" }],
      onTool: async (call) => {
        if (call.name !== "list_pages") {
          return undefined;
        }
        listCalls += 1;
        if (listCalls === 1) {
          markFirstStarted();
          await firstGate;
        }
        return undefined;
      },
    });
    setChromeMcpSessionFactoryForTest(async () => session);

    const first = listChromeMcpTabs("chrome-live");
    await firstStarted;
    const ctrl = new AbortController();
    const aborted = listChromeMcpTabs("chrome-live", undefined, { signal: ctrl.signal });
    const timedOut = listChromeMcpTabs("chrome-live", undefined, { timeoutMs: 20 });
    const abortedExpectation = expect(aborted).rejects.toThrow(/queued caller cancelled/);
    const timedOutExpectation = expect(timedOut).rejects.toThrow(
      /timed out after 20ms while waiting/,
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    ctrl.abort(new Error("queued caller cancelled"));

    await abortedExpectation;
    await timedOutExpectation;
    expect(listCalls).toBe(1);
    releaseFirst();
    await first;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(listCalls).toBe(1);
  });

  it("wraps snapshot refs and rejects stale or cross-target refs before dispatch", async () => {
    const clickedUids: unknown[] = [];
    const session = createPageSession({
      pid: 140,
      pages: [
        { id: 1, url: "https://a.example" },
        { id: 2, url: "https://b.example" },
      ],
      onTool: (call) => {
        if (call.name === "take_snapshot") {
          return {
            structuredContent: {
              snapshot: {
                id: "root",
                role: "document",
                children: [{ id: "1_2", role: "button", name: "Run" }],
              },
            },
          };
        }
        if (call.name === "click") {
          clickedUids.push(call.arguments?.uid);
          return { content: [{ type: "text", text: "clicked" }] };
        }
        return undefined;
      },
    });
    setChromeMcpSessionFactoryForTest(async () => session);

    const [targetA, targetB] = (await listChromeMcpTabs("chrome-live")).map((tab) => tab.targetId);
    const first = await takeChromeMcpSnapshot({
      profileName: "chrome-live",
      targetId: targetA ?? "",
    });
    const firstRef = first.children?.[0]?.id;
    expect(firstRef).toMatch(/^mcp-ref:/);
    await clickChromeMcpElement({
      profileName: "chrome-live",
      targetId: targetA ?? "",
      uid: firstRef ?? "",
    });
    await expect(
      clickChromeMcpElement({
        profileName: "chrome-live",
        targetId: targetB ?? "",
        uid: firstRef ?? "",
      }),
    ).rejects.toThrow(/Run a new snapshot/);

    const second = await takeChromeMcpSnapshot({
      profileName: "chrome-live",
      targetId: targetA ?? "",
    });
    const secondRef = second.children?.[0]?.id;
    expect(secondRef).not.toBe(firstRef);
    await expect(
      clickChromeMcpElement({
        profileName: "chrome-live",
        targetId: targetA ?? "",
        uid: firstRef ?? "",
      }),
    ).rejects.toThrow(/Run a new snapshot/);
    await clickChromeMcpElement({
      profileName: "chrome-live",
      targetId: targetA ?? "",
      uid: secondRef ?? "",
    });
    expect(clickedUids).toEqual(["1_2", "1_2"]);
  });

  it("unwraps current snapshot refs for every ref-scoped MCP adapter", async () => {
    const session = createPageSession({
      pid: 141,
      pages: [{ id: 1, url: "https://a.example" }],
      onTool: async (call) => {
        if (call.name === "take_snapshot") {
          return {
            structuredContent: {
              snapshot: {
                id: "root",
                role: "document",
                children: [
                  { id: "uid-a", role: "textbox", name: "A" },
                  { id: "uid-b", role: "textbox", name: "B" },
                ],
              },
            },
          };
        }
        if (call.name === "take_screenshot") {
          await fs.writeFile(`${String(call.arguments?.filePath)}.png`, Buffer.from("png"));
          return { content: [{ type: "text", text: "saved" }] };
        }
        if (call.name === "evaluate_script") {
          return { content: [{ type: "text", text: "```json\nnull\n```" }] };
        }
        if (["fill", "fill_form", "hover", "drag", "upload_file"].includes(call.name)) {
          return { content: [{ type: "text", text: "ok" }] };
        }
        return undefined;
      },
    });
    setChromeMcpSessionFactoryForTest(async () => session);
    const targetId = (await listChromeMcpTabs("chrome-live"))[0]?.targetId ?? "";
    const snapshot = await takeChromeMcpSnapshot({ profileName: "chrome-live", targetId });
    const refA = snapshot.children?.[0]?.id ?? "";
    const refB = snapshot.children?.[1]?.id ?? "";

    await takeChromeMcpScreenshot({ profileName: "chrome-live", targetId, uid: refA });
    await fillChromeMcpElement({ profileName: "chrome-live", targetId, uid: refA, value: "x" });
    await fillChromeMcpForm({
      profileName: "chrome-live",
      targetId,
      elements: [
        { uid: refA, value: "x" },
        { uid: refB, value: "y" },
      ],
    });
    await hoverChromeMcpElement({ profileName: "chrome-live", targetId, uid: refA });
    await dragChromeMcpElement({
      profileName: "chrome-live",
      targetId,
      fromUid: refA,
      toUid: refB,
    });
    await uploadChromeMcpFile({
      profileName: "chrome-live",
      targetId,
      uid: refA,
      filePath: "/tmp/input.txt",
    });
    await evaluateChromeMcpScript({
      profileName: "chrome-live",
      targetId,
      fn: "(a, b) => [a, b]",
      args: [refA, refB],
    });

    const calls = (session.client.callTool as unknown as ToolCallMock).mock.calls.map(
      ([call]) => call,
    );
    const argsFor = (name: string) => calls.find((call) => call.name === name)?.arguments;
    expect(argsFor("take_screenshot")).toMatchObject({ pageId: 1, uid: "uid-a" });
    expect(argsFor("fill")).toMatchObject({ pageId: 1, uid: "uid-a", value: "x" });
    expect(argsFor("fill_form")).toMatchObject({
      pageId: 1,
      elements: [
        { uid: "uid-a", value: "x" },
        { uid: "uid-b", value: "y" },
      ],
    });
    expect(argsFor("hover")).toMatchObject({ pageId: 1, uid: "uid-a" });
    expect(argsFor("drag")).toMatchObject({ pageId: 1, from_uid: "uid-a", to_uid: "uid-b" });
    expect(argsFor("upload_file")).toMatchObject({
      pageId: 1,
      uid: "uid-a",
      filePath: "/tmp/input.txt",
    });
    expect(argsFor("evaluate_script")).toMatchObject({
      pageId: 1,
      args: ["uid-a", "uid-b"],
    });
  });

  it("rejects a pre-reconnect ref against the freshly listed target", async () => {
    let factoryCalls = 0;
    let clickCalls = 0;
    setChromeMcpSessionFactoryForTest(async () => {
      factoryCalls += 1;
      return createPageSession({
        pid: 141 + factoryCalls,
        pages: [{ id: 1, url: "https://a.example" }],
        onTool: (call) => {
          if (call.name === "take_snapshot") {
            return {
              structuredContent: {
                snapshot: { id: "1_2", role: "button", name: "Run" },
              },
            };
          }
          if (call.name === "click") {
            clickCalls += 1;
          }
          return undefined;
        },
      });
    });

    const oldTargetId = (await listChromeMcpTabs("chrome-live"))[0]?.targetId ?? "";
    const snapshot = await takeChromeMcpSnapshot({
      profileName: "chrome-live",
      targetId: oldTargetId,
    });
    await closeChromeMcpSession("chrome-live");
    const freshTargetId = (await listChromeMcpTabs("chrome-live"))[0]?.targetId ?? "";

    await expect(
      clickChromeMcpElement({
        profileName: "chrome-live",
        targetId: freshTargetId,
        uid: snapshot.id ?? "",
      }),
    ).rejects.toThrow(/Run a new snapshot/);
    expect(factoryCalls).toBe(2);
    expect(clickCalls).toBe(0);
  });

  it("does not replay a mutation after its transport reports an uncertain outcome", async () => {
    let factoryCalls = 0;
    let clickCalls = 0;
    setChromeMcpSessionFactoryForTest(async () => {
      factoryCalls += 1;
      return createPageSession({
        pid: 150 + factoryCalls,
        pages: [{ id: 1, url: "https://a.example" }],
        onTool: (call) => {
          if (call.name === "take_snapshot") {
            return {
              structuredContent: {
                snapshot: { id: "1_2", role: "button", name: "Run" },
              },
            };
          }
          if (call.name === "click") {
            clickCalls += 1;
            throw new Error("connection reset after dispatch");
          }
          return undefined;
        },
      });
    });

    const targetId = (await listChromeMcpTabs("chrome-live"))[0]?.targetId ?? "";
    const snapshot = await takeChromeMcpSnapshot({
      profileName: "chrome-live",
      targetId,
    });
    await expect(
      clickChromeMcpElement({
        profileName: "chrome-live",
        targetId,
        uid: snapshot.id ?? "",
      }),
    ).rejects.toThrow(/connection reset after dispatch/);
    expect(clickCalls).toBe(1);
    expect(factoryCalls).toBe(1);

    await listChromeMcpTabs("chrome-live");
    expect(factoryCalls).toBe(2);
  });

  it("suggests cdpUrl when auto-connect cannot read DevToolsActivePort", async () => {
    setChromeMcpSessionFactoryForTest(async () =>
      createToolErrorSession(
        "Could not connect to Chrome in /tmp/chrome-profile. Cause: ENOENT: no such file or directory, open '/tmp/chrome-profile/DevToolsActivePort'",
      ),
    );

    await expect(
      listChromeMcpTabs("chrome-live", { userDataDir: "/tmp/chrome-profile" }),
    ).rejects.toThrow(/set browser\.profiles\.chrome-live\.cdpUrl/);
  });

  it("names the configured endpoint when endpoint attach fails", async () => {
    setChromeMcpSessionFactoryForTest(async () =>
      createToolErrorSession("Could not connect to Chrome: ECONNREFUSED"),
    );

    await expect(
      listChromeMcpTabs("chrome-live", {
        cdpUrl:
          "https://alice:supersecretpasswordvalue1234@example.com/chrome?token=supersecrettokenvalue1234567890",
      }),
    ).rejects.toThrow(
      /configured Chrome endpoint \(https:\/\/example\.com\/chrome\?token=\*\*\*\)/,
    );
  });

  it("reads screenshot files with the extension written by chrome-devtools-mcp", async () => {
    const factory: ChromeMcpSessionFactory = async () => createFakeSession();
    setChromeMcpSessionFactoryForTest(factory);

    await expect(
      takeChromeMcpScreenshot({
        profileName: "chrome-live",
        targetId: FAKE_TARGET_1,
        format: "jpeg",
      }),
    ).resolves.toEqual(Buffer.from("screenshot:jpeg"));
  });

  it("terminates the owned Chrome MCP subprocess tree when closing temporary sessions", async () => {
    const session = createFakeSession();
    Object.assign(session, { processCleanup: { status: "open" } });
    const closeMock = vi.fn().mockResolvedValue(undefined);
    session.client.close = closeMock as typeof session.client.close;
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const alive = new Set([123, 124, 125]);
    setChromeMcpProcessCleanupDepsForTest({
      platform: "linux",
      listProcesses: vi.fn(async () =>
        [
          processSnapshot(123, 1),
          processSnapshot(124, 123),
          processSnapshot(125, 124),
          processSnapshot(126, 1),
        ].filter(({ pid }) => alive.has(pid)),
      ),
      killProcess: (pid, signal) => {
        killCalls.push({ pid, signal });
        if (signal === "SIGKILL") {
          alive.delete(pid);
        }
      },
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    setChromeMcpSessionFactoryForTest(async () => session);

    await ensureChromeMcpAvailable("chrome-live", undefined, { ephemeral: true });

    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(killCalls).toEqual([
      { pid: 125, signal: "SIGTERM" },
      { pid: 124, signal: "SIGTERM" },
      { pid: 123, signal: "SIGTERM" },
      { pid: 125, signal: "SIGKILL" },
      { pid: 124, signal: "SIGKILL" },
      { pid: 123, signal: "SIGKILL" },
    ]);
  });

  it("retains the proven root while skipping exited and reparented descendants", async () => {
    const session = createFakeSession();
    Object.assign(session, { processCleanup: { status: "open" } });
    const alive = new Set([123, 124, 125]);
    const killProcess = vi.fn((pid: number, signal: NodeJS.Signals) => {
      if (signal === "SIGKILL") {
        alive.delete(pid);
      }
    });
    setChromeMcpProcessCleanupDepsForTest({
      platform: "linux",
      listProcesses: vi.fn(async () =>
        [
          processSnapshot(123, 1),
          // 124 reparented before the snapshot; 125 remains its child. An exited
          // child is simply absent. Neither can become owned through stale ancestry.
          processSnapshot(124, 999),
          processSnapshot(125, 124),
        ].filter(({ pid }) => alive.has(pid)),
      ),
      killProcess,
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    setChromeMcpSessionFactoryForTest(async () => session);

    await ensureChromeMcpAvailable("chrome-live", undefined, { ephemeral: true });

    expect(killProcess).toHaveBeenCalledWith(123, "SIGTERM");
    expect(killProcess).toHaveBeenCalledWith(123, "SIGKILL");
    expect(killProcess).not.toHaveBeenCalledWith(124, expect.anything());
    expect(killProcess).not.toHaveBeenCalledWith(125, expect.anything());
  });

  it("keeps snapshot uncertainty closed after the root disappears", async () => {
    const session = createFakeSession();
    Object.assign(session, { processCleanup: { status: "open" } });
    const listProcesses = vi.fn().mockRejectedValue(new Error("process enumeration failed"));
    const closeMock = vi.fn(async () => {
      (session.transport as { pid: number | null }).pid = null;
    });
    session.client.close = closeMock as typeof session.client.close;
    setChromeMcpProcessCleanupDepsForTest({
      platform: "linux",
      listProcesses,
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    const factory = vi.fn(async () => session);
    setChromeMcpSessionFactoryForTest(factory);

    await expect(
      ensureChromeMcpAvailable("chrome-live", undefined, { ephemeral: true }),
    ).rejects.toThrow("process enumeration failed");
    expect(closeMock).toHaveBeenCalledOnce();
    await expect(listChromeMcpTabs("chrome-live")).rejects.toThrow(
      "subprocess tree cleanup could not be verified",
    );
    expect(factory).toHaveBeenCalledOnce();

    (session.transport as { pid: number | null }).pid = 123;
    let alive = true;
    listProcesses.mockImplementation(async () => (alive ? [processSnapshot(123, 1)] : []));
    setChromeMcpProcessCleanupDepsForTest({
      platform: "linux",
      listProcesses,
      killProcess: (_pid, signal) => {
        if (signal === "SIGKILL") {
          alive = false;
        }
      },
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    await expect(closeChromeMcpSession("chrome-live")).resolves.toBe(true);
  });

  it("uses Windows taskkill tree cleanup without waiting for SDK stdio close timeout", async () => {
    const session = createFakeSession();
    Object.assign(session, { processCleanup: { status: "open" } });
    const closeOrder: string[] = [];
    let alive = true;
    session.client.close = vi.fn(async () => {
      closeOrder.push("client.close");
    }) as typeof session.client.close;
    setChromeMcpProcessCleanupDepsForTest({
      platform: "win32",
      listProcesses: vi.fn(async () => (alive ? [processSnapshot(123, 1)] : [])),
      taskkillProcessTree: vi.fn(async (pid) => {
        closeOrder.push(`taskkill:${pid}`);
        alive = false;
      }),
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    setChromeMcpSessionFactoryForTest(async () => session);

    await ensureChromeMcpAvailable("chrome-live", undefined, { ephemeral: true });

    expect(closeOrder).toEqual(["taskkill:123", "client.close"]);
  });

  it("retains a Windows subprocess handle until failed taskkill cleanup can be retried", async () => {
    const session = createFakeSession();
    Object.assign(session, { processCleanup: { status: "open" } });
    const closeMock = vi.fn(async () => {
      (session.transport as { pid: number | null }).pid = null;
    });
    session.client.close = closeMock as typeof session.client.close;
    setChromeMcpProcessCleanupDepsForTest({
      platform: "win32",
      listProcesses: vi.fn().mockResolvedValue([processSnapshot(123, 1)]),
      taskkillProcessTree: vi.fn().mockRejectedValue(new Error("taskkill failed")),
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    setChromeMcpSessionFactoryForTest(async () => session);

    await expect(
      ensureChromeMcpAvailable("chrome-live", undefined, { ephemeral: true }),
    ).rejects.toThrow("taskkill failed");

    expect(closeMock).toHaveBeenCalledTimes(1);

    let alive = true;
    const taskkillProcessTree = vi.fn(async () => {
      alive = false;
    });
    setChromeMcpProcessCleanupDepsForTest({
      platform: "win32",
      listProcesses: vi.fn(async () => (alive ? [processSnapshot(123, 1)] : [])),
      taskkillProcessTree,
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    await expect(closeChromeMcpSession("chrome-live")).resolves.toBe(true);
    expect(taskkillProcessTree).toHaveBeenCalledExactlyOnceWith(123);
  });

  it("never taskkills a retained pid after its process identity changes", async () => {
    const session = createFakeSession();
    Object.assign(session, { processCleanup: { status: "open" } });
    session.client.close = vi.fn(async () => {
      (session.transport as { pid: number | null }).pid = null;
    }) as typeof session.client.close;
    let identity = "start-123";
    const taskkillProcessTree = vi.fn().mockRejectedValue(new Error("taskkill failed"));
    setChromeMcpProcessCleanupDepsForTest({
      platform: "win32",
      listProcesses: vi.fn(async () => [processSnapshot(123, 1, identity)]),
      taskkillProcessTree,
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    setChromeMcpSessionFactoryForTest(async () => session);

    await expect(
      ensureChromeMcpAvailable("chrome-live", undefined, { ephemeral: true }),
    ).rejects.toThrow("taskkill failed");
    identity = "start-reused";

    await expect(closeChromeMcpSession("chrome-live")).resolves.toBe(true);
    expect(taskkillProcessTree).toHaveBeenCalledTimes(1);
  });

  it("cleans a pinned Windows descendant after its exited root is gone", async () => {
    const session = createFakeSession();
    Object.assign(session, {
      processCleanup: {
        status: "tracked",
        target: {
          root: { pid: 123, identity: "start-123" },
          descendants: [{ pid: 124, identity: "start-124" }],
        },
      },
    });
    const alive = new Set([124]);
    const taskkillProcessTree = vi.fn(async (pid: number) => {
      alive.delete(pid);
    });
    setChromeMcpProcessCleanupDepsForTest({
      platform: "win32",
      listProcesses: vi.fn(async () =>
        [processSnapshot(123, 1), processSnapshot(124, 123)].filter(({ pid }) => alive.has(pid)),
      ),
      taskkillProcessTree,
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    setChromeMcpSessionFactoryForTest(async () => session);

    await ensureChromeMcpAvailable("chrome-live", undefined, { ephemeral: true });

    expect(taskkillProcessTree).toHaveBeenCalledExactlyOnceWith(124);
    expect(taskkillProcessTree).not.toHaveBeenCalledWith(123);
  });

  it("surfaces a surviving Chrome MCP process and retries its exact retained handle", async () => {
    const session = createFakeSession();
    Object.assign(session, { processCleanup: { status: "open" } });
    const closeMock = vi.fn(async () => {
      (session.transport as { pid: number | null }).pid = null;
    });
    session.client.close = closeMock as typeof session.client.close;
    const killProcess = vi.fn();
    setChromeMcpProcessCleanupDepsForTest({
      platform: "linux",
      listProcesses: vi.fn().mockResolvedValue([processSnapshot(123, 1)]),
      killProcess,
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    const factory = vi.fn(async () => session);
    setChromeMcpSessionFactoryForTest(factory);

    await expect(
      ensureChromeMcpAvailable("chrome-live", undefined, { ephemeral: true }),
    ).rejects.toThrow("cleanup failed for pid 123");
    await expect(listChromeMcpTabs("chrome-live")).rejects.toThrow("cleanup failed for pid 123");
    expect(factory).toHaveBeenCalledOnce();

    let alive = true;
    setChromeMcpProcessCleanupDepsForTest({
      platform: "linux",
      listProcesses: vi.fn(async () => (alive ? [processSnapshot(123, 1)] : [])),
      killProcess: (pid, signal) => {
        killProcess(pid, signal);
        if (signal === "SIGKILL") {
          alive = false;
        }
      },
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    await expect(closeChromeMcpSession("chrome-live")).resolves.toBe(true);
    expect(closeMock).toHaveBeenCalledTimes(3);
  });

  it("redacts remote CDP URL secrets from attach failures", async () => {
    const secretToken = "browserless-secret-token-1234567890"; // pragma: allowlist secret
    const user = "browser-user";
    const password = "browser-password-1234567890"; // pragma: allowlist secret
    const cdpUrl = `wss://${user}:${password}@browserless.example/chrome?token=${secretToken}`;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chrome-mcp-test-"));
    const configPath = path.join(tempDir, "openclaw.json");
    await fs.writeFile(configPath, JSON.stringify({ logging: { redactSensitive: "off" } }));
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    const fakeMcpCommand = path.join(tempDir, "fake-mcp.mjs");
    await fs.writeFile(
      fakeMcpCommand,
      `#!/usr/bin/env node
      const cdpUrl = process.argv.find((arg) => arg.includes("browserless.example")) ?? "";
      let input = "";
      process.stdin.on("data", (chunk) => {
        input += chunk;
        const match = input.match(/"id"\\s*:\\s*(\\d+)/);
        if (!match) return;
        const body = JSON.stringify({
          jsonrpc: "2.0",
          id: Number(match[1]),
          error: { code: -32000, message: "attach failed for " + cdpUrl },
        });
        process.stdout.write(body + "\\n");
      });
    `,
    );
    await fs.chmod(fakeMcpCommand, 0o755);

    let message = "";
    try {
      await ensureChromeMcpAvailable(
        "remote-profile",
        {
          cdpUrl,
          mcpCommand: fakeMcpCommand,
        },
        { ephemeral: true },
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    expect(message).toContain("Chrome MCP existing-session attach failed");
    expect(message).toContain("attach failed");
    expect(message).toContain("browserless.example");
    expect(message).not.toContain(cdpUrl);
    expect(message).not.toContain(user);
    expect(message).not.toContain(password);
    expect(message).not.toContain(secretToken);
  });

  it("redacts home-relative user data dirs from attach failures", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chrome-mcp-test-"));
    const homeDir = os.homedir();
    const userDataDir = path.join(
      homeDir,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
      "Profile 1",
    );
    const attachFailureDetail = `attach failed for ${userDataDir}`;
    const fakeMcpCommand = path.join(tempDir, "fake-mcp.mjs");
    await fs.writeFile(
      fakeMcpCommand,
      `#!/usr/bin/env node
      let input = "";
      process.stdin.on("data", (chunk) => {
        input += chunk;
        const match = input.match(/"id"\\s*:\\s*(\\d+)/);
        if (!match) return;
        const body = JSON.stringify({
          jsonrpc: "2.0",
          id: Number(match[1]),
          error: { code: -32000, message: ${JSON.stringify(attachFailureDetail)} },
        });
        process.stdout.write(body + "\\n");
      });
    `,
    );
    await fs.chmod(fakeMcpCommand, 0o755);

    let message = "";
    try {
      await ensureChromeMcpAvailable(
        "home-profile",
        {
          userDataDir,
          mcpCommand: fakeMcpCommand,
        },
        { ephemeral: true },
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    expect(message).toContain("Chrome MCP existing-session attach failed");
    expect(message).toContain("~/Library/Application Support/Google/Chrome/Profile 1");
    expect(message).toContain(
      "attach failed for ~/Library/Application Support/Google/Chrome/Profile 1",
    );
    expect(message).not.toContain(homeDir);
    expect(message).not.toContain(userDataDir);
  });

  it("keeps Chrome MCP stderr tails within the byte cap without splitting UTF-8", () => {
    const output = decodeChromeMcpStderrTail(Buffer.from(`${"x".repeat(8191)}é`));

    expect(output).toMatch(/é$/);
    expect(output).not.toContain("�");
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(8192);
  });

  it("parses new_page text responses and returns the created tab", async () => {
    const session = createFakeSession();
    const factory: ChromeMcpSessionFactory = async () => session;
    setChromeMcpSessionFactoryForTest(factory);

    const tab = await openChromeMcpTab("chrome-live", "https://example.com/");

    expect(tab).toEqual({
      targetId: expect.stringMatching(/^chrome-mcp:/),
      title: "",
      url: "https://example.com/",
      type: "page",
    });
    const calls = (session.client.callTool as unknown as ToolCallMock).mock.calls;
    expect(calls.map(([call]) => call.name)).toEqual(["new_page", "navigate_page", "list_pages"]);
    expect(calls[2]?.[2]?.timeout).toBe(25_000);
  });

  it("opens about:blank directly without an extra navigate", async () => {
    const session = createFakeSession();
    const factory: ChromeMcpSessionFactory = async () => session;
    setChromeMcpSessionFactoryForTest(factory);

    const tab = await openChromeMcpTab("chrome-live", "about:blank");

    expect(tab).toEqual({
      targetId: expect.stringMatching(/^chrome-mcp:/),
      title: "",
      url: "about:blank",
      type: "page",
    });
    expect(session.client["callTool"]).toHaveBeenCalledWith({
      name: "new_page",
      arguments: { url: "about:blank", timeout: 5000 },
    });
    const callToolMock = session.client["callTool"] as unknown as ToolCallMock;
    const callNames = callToolMock.mock.calls.map(([call]) => call.name);
    expect(callNames).toEqual(["new_page"]);
  });

  it("preserves unrelated targets and refs when new_page returns only the created page", async () => {
    let clickedUid: unknown;
    const session = createPageSession({
      pid: 160,
      pages: [{ id: 1, url: "https://a.example" }],
      onTool: (call) => {
        if (call.name === "take_snapshot") {
          return {
            structuredContent: {
              snapshot: { id: "uid-a", role: "button", name: "Run A" },
            },
          };
        }
        if (call.name === "new_page") {
          return {
            structuredContent: {
              pages: [{ id: 2, url: "about:blank", selected: true }],
            },
          };
        }
        if (call.name === "click") {
          clickedUid = call.arguments?.uid;
          return { content: [{ type: "text", text: "clicked" }] };
        }
        return undefined;
      },
    });
    setChromeMcpSessionFactoryForTest(async () => session);

    const originalTarget = (await listChromeMcpTabs("chrome-live"))[0]?.targetId ?? "";
    const snapshot = await takeChromeMcpSnapshot({
      profileName: "chrome-live",
      targetId: originalTarget,
    });
    await openChromeMcpTab("chrome-live", "about:blank");
    await clickChromeMcpElement({
      profileName: "chrome-live",
      targetId: originalTarget,
      uid: snapshot.id ?? "",
    });

    expect(clickedUid).toBe("uid-a");
    const calls = (session.client.callTool as unknown as ToolCallMock).mock.calls.map(
      ([call]) => call.name,
    );
    expect(calls).toEqual(["list_pages", "take_snapshot", "new_page", "click"]);
  });

  it("parses evaluate_script text responses when structuredContent is missing", async () => {
    const factory: ChromeMcpSessionFactory = async () => createFakeSession();
    setChromeMcpSessionFactoryForTest(factory);

    const result = await evaluateChromeMcpScript({
      profileName: "chrome-live",
      targetId: FAKE_TARGET_1,
      fn: "() => 123",
    });

    expect(result).toBe(123);
  });

  it("defaults non-finite coordinate click delays before injecting the browser script", async () => {
    const session = createFakeSession();
    const callTool = vi.fn(async ({ name }: ToolCall) => {
      if (name === "list_pages") {
        return fakeListPagesResult();
      }
      if (name === "evaluate_script") {
        return { content: [{ type: "text", text: "```json\nnull\n```" }] };
      }
      throw new Error(`unexpected tool ${name}`);
    });
    session.client.callTool = callTool as typeof session.client.callTool;
    setChromeMcpSessionFactoryForTest(async () => session);

    await clickChromeMcpCoords({
      profileName: "chrome-live",
      targetId: FAKE_TARGET_1,
      x: 10,
      y: 20,
      delayMs: Number.NaN,
    });

    const callToolMock = callTool as unknown as ToolCallMock;
    const evaluateCall = callToolMock.mock.calls.find(([call]) => call.name === "evaluate_script");
    const fn = evaluateCall?.[0].arguments?.function;
    expect(typeof fn === "string" ? fn : "").toContain("const delayMs = 0;");
  });

  it("keeps handle-producing list calls persistent even if a legacy caller passes ephemeral", async () => {
    let factoryCalls = 0;
    const session = createFakeSession();
    const close = vi.fn().mockResolvedValue(undefined);
    session.client.close = close as typeof session.client.close;
    setChromeMcpSessionFactoryForTest(async () => {
      factoryCalls += 1;
      return session;
    });
    const legacyOptions = { ephemeral: true } as unknown as Parameters<typeof listChromeMcpTabs>[2];

    const targetId = (await listChromeMcpTabs("chrome-live", undefined, legacyOptions))[0]
      ?.targetId;
    await expect(
      evaluateChromeMcpScript({
        profileName: "chrome-live",
        targetId: targetId ?? "",
        fn: "() => 123",
      }),
    ).resolves.toBe(123);
    expect(factoryCalls).toBe(1);
    expect(close).not.toHaveBeenCalled();
  });

  it("does not cache an ephemeral availability probe before the next real attach", async () => {
    let factoryCalls = 0;
    const closeMocks: Array<ReturnType<typeof vi.fn>> = [];
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      const closeMock = vi.fn().mockResolvedValue(undefined);
      session.client.close = closeMock as typeof session.client.close;
      closeMocks.push(closeMock);
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    await ensureChromeMcpAvailable("chrome-live", undefined, { ephemeral: true });

    expect(factoryCalls).toBe(1);
    expect(closeMocks[0]).toHaveBeenCalledTimes(1);

    const tabs = await listChromeMcpTabs("chrome-live");

    expect(factoryCalls).toBe(2);
    expect(closeMocks[1]).not.toHaveBeenCalled();
    expect(tabs).toHaveLength(2);
  });

  it("does not poison the next real attach after an ephemeral no-page probe", async () => {
    let factoryCalls = 0;
    const closeMocks: Array<ReturnType<typeof vi.fn>> = [];
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      const closeMock = vi.fn().mockResolvedValue(undefined);
      session.client.close = closeMock as typeof session.client.close;
      closeMocks.push(closeMock);
      if (factoryCalls === 1) {
        const callTool = vi.fn(async ({ name }: ToolCall) => {
          if (name === "list_pages") {
            return {
              content: [{ type: "text", text: "No page selected" }],
              isError: true,
            };
          }
          throw new Error(`unexpected tool ${name}`);
        });
        session.client.callTool = callTool as typeof session.client.callTool;
      }
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    await expect(
      countChromeMcpTabs("chrome-live", undefined, {
        ephemeral: true,
      }),
    ).rejects.toThrow(/No page selected/);

    expect(factoryCalls).toBe(1);
    expect(closeMocks[0]).toHaveBeenCalledTimes(1);

    const tabs = await listChromeMcpTabs("chrome-live");

    expect(factoryCalls).toBe(2);
    expect(closeMocks[1]).not.toHaveBeenCalled();
    expect(tabs).toHaveLength(2);
  });

  it("surfaces MCP tool errors instead of JSON parse noise", async () => {
    const factory: ChromeMcpSessionFactory = async () => {
      const session = createFakeSession();
      const callTool = vi.fn(async ({ name }: ToolCall) => {
        if (name === "list_pages") {
          return fakeListPagesResult();
        }
        if (name === "evaluate_script") {
          return {
            content: [
              {
                type: "text",
                text: "Cannot read properties of null (reading 'value')",
              },
            ],
            isError: true,
          };
        }
        throw new Error(`unexpected tool ${name}`);
      });
      session.client.callTool = callTool as typeof session.client.callTool;
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    await expect(
      evaluateChromeMcpScript({
        profileName: "chrome-live",
        targetId: FAKE_TARGET_1,
        fn: "() => document.getElementById('missing').value",
      }),
    ).rejects.toThrow(/Cannot read properties of null/);
  });

  it("reuses a single pending session for concurrent requests", async () => {
    let factoryCalls = 0;
    let releaseFactory: (() => void) | undefined;
    const factoryGate = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    if (!releaseFactory) {
      throw new Error("Expected Chrome MCP factory release callback to be initialized");
    }

    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      await factoryGate;
      return createFakeSession();
    };
    setChromeMcpSessionFactoryForTest(factory);

    const tabsPromise = listChromeMcpTabs("chrome-live");
    const evalPromise = evaluateChromeMcpScript({
      profileName: "chrome-live",
      targetId: FAKE_TARGET_1,
      fn: "() => 123",
    });

    releaseFactory();
    const [tabs, result] = await Promise.all([tabsPromise, evalPromise]);

    expect(factoryCalls).toBe(1);
    expect(tabs).toHaveLength(2);
    expect(result).toBe(123);
  });

  it("keeps a shared pending session alive when one waiter aborts", async () => {
    let factoryCalls = 0;
    let releaseFactory: (() => void) | undefined;
    const factoryGate = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    if (!releaseFactory) {
      throw new Error("Expected Chrome MCP factory release callback to be initialized");
    }

    const closeMock = vi.fn().mockResolvedValue(undefined);
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      await factoryGate;
      const session = createFakeSession();
      session.client.close = closeMock as typeof session.client.close;
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    const ctrl = new AbortController();
    const keptCtrl = new AbortController();
    const abortedTabsPromise = listChromeMcpTabs("chrome-live", undefined, {
      signal: ctrl.signal,
    });
    const tabsPromise = listChromeMcpTabs("chrome-live", undefined, {
      signal: keptCtrl.signal,
    });

    const abortedTabsExpectation =
      expect(abortedTabsPromise).rejects.toThrow(/first caller cancelled/);
    ctrl.abort(new Error("first caller cancelled"));
    releaseFactory();

    await abortedTabsExpectation;
    await expect(tabsPromise).resolves.toHaveLength(2);
    expect(factoryCalls).toBe(1);
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("closes a shared pending session when every waiter aborts", async () => {
    let factoryCalls = 0;
    let releaseFactory: (() => void) | undefined;
    const factoryGate = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    if (!releaseFactory) {
      throw new Error("Expected Chrome MCP factory release callback to be initialized");
    }

    const closeMock = vi.fn().mockResolvedValue(undefined);
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      await factoryGate;
      const session = createFakeSession();
      session.client.close = closeMock as typeof session.client.close;
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    const ctrl = new AbortController();
    const tabsPromise = listChromeMcpTabs("chrome-live", undefined, {
      signal: ctrl.signal,
    });
    const tabsExpectation = expect(tabsPromise).rejects.toThrow(/caller cancelled/);

    await vi.waitFor(() => expect(factoryCalls).toBe(1));
    ctrl.abort(new Error("caller cancelled"));
    releaseFactory();

    await tabsExpectation;
    await vi.waitFor(() => expect(closeMock).toHaveBeenCalledTimes(1));
    expect(factoryCalls).toBe(1);
  });

  it("closes the exact session when the last waiter aborts as creation settles", async () => {
    const ctrl = new AbortController();
    const session = createFakeSession();
    const closeMock = vi.fn().mockResolvedValue(undefined);
    session.client.close = closeMock as typeof session.client.close;
    setChromeMcpSessionFactoryForTest(async () => {
      queueMicrotask(() =>
        queueMicrotask(() => queueMicrotask(() => ctrl.abort(new Error("settlement cancelled")))),
      );
      return session;
    });

    await expect(
      listChromeMcpTabs("chrome-live", undefined, { signal: ctrl.signal }),
    ).rejects.toThrow("settlement cancelled");
    expect(closeMock).toHaveBeenCalledOnce();
  });

  it("reset waits for an already-detached pending factory and its exact cleanup", async () => {
    let factoryCalls = 0;
    let releaseFactory!: () => void;
    const factoryGate = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    const closeMock = vi.fn().mockResolvedValue(undefined);
    setChromeMcpSessionFactoryForTest(async () => {
      factoryCalls += 1;
      await factoryGate;
      const session = createFakeSession();
      session.client.close = closeMock as typeof session.client.close;
      return session;
    });
    const ctrl = new AbortController();
    const tabsPromise = listChromeMcpTabs("chrome-live", undefined, { signal: ctrl.signal });
    const tabsExpectation = expect(tabsPromise).rejects.toThrow("caller cancelled");
    await vi.waitFor(() => expect(factoryCalls).toBe(1));
    ctrl.abort(new Error("caller cancelled"));
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    let resetSettled = false;
    const resetting = resetChromeMcpSessionsForTest().then(() => {
      resetSettled = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(resetSettled).toBe(false);

    releaseFactory();
    await Promise.all([tabsExpectation, resetting]);
    expect(closeMock).toHaveBeenCalledOnce();
  });

  it("blocks replacement after an aborted pending factory fails exact cleanup", async () => {
    let factoryCalls = 0;
    let releaseFactory!: () => void;
    const factoryGate = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    const closeMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("pending cleanup failed"))
      .mockResolvedValue(undefined);
    setChromeMcpSessionFactoryForTest(async () => {
      factoryCalls += 1;
      if (factoryCalls === 1) {
        await factoryGate;
        const session = createFakeSession();
        session.client.close = closeMock as typeof session.client.close;
        return session;
      }
      return createFakeSession();
    });
    const ctrl = new AbortController();
    const aborted = listChromeMcpTabs("chrome-live", undefined, { signal: ctrl.signal });
    const abortedExpectation = expect(aborted).rejects.toThrow("pending cleanup failed");
    await vi.waitFor(() => expect(factoryCalls).toBe(1));
    ctrl.abort(new Error("caller cancelled"));

    const blockedReplacement = listChromeMcpTabs("chrome-live");
    const blockedReplacementExpectation =
      expect(blockedReplacement).rejects.toThrow("pending cleanup failed");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(factoryCalls).toBe(1);
    releaseFactory();

    await Promise.all([abortedExpectation, blockedReplacementExpectation]);
    expect(factoryCalls).toBe(1);
    await expect(listChromeMcpTabs("chrome-live")).resolves.toHaveLength(2);
    expect(factoryCalls).toBe(2);
    expect(closeMock).toHaveBeenCalledTimes(2);
  });

  it("waits for an aborted pending attach to close before starting its replacement", async () => {
    let factoryCalls = 0;
    const releaseFactories: Array<() => void> = [];
    const closeMocks: Array<ReturnType<typeof vi.fn>> = [];
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      let releaseFactory: (() => void) | undefined;
      const factoryGate = new Promise<void>((resolve) => {
        releaseFactory = resolve;
      });
      if (!releaseFactory) {
        throw new Error("Expected Chrome MCP factory release callback to be initialized");
      }
      releaseFactories.push(releaseFactory);
      await factoryGate;
      const session = createFakeSession();
      const closeMock = vi.fn().mockResolvedValue(undefined);
      closeMocks.push(closeMock);
      session.client.close = closeMock as typeof session.client.close;
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    const ctrl = new AbortController();
    const abortedTabsPromise = listChromeMcpTabs("chrome-live", undefined, {
      signal: ctrl.signal,
    });
    const abortedTabsExpectation = expect(abortedTabsPromise).rejects.toThrow(/caller cancelled/);

    await vi.waitFor(() => expect(factoryCalls).toBe(1));
    ctrl.abort(new Error("caller cancelled"));

    const tabsPromise = listChromeMcpTabs("chrome-live");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(factoryCalls).toBe(1);
    releaseFactories[0]?.();
    await abortedTabsExpectation;
    await vi.waitFor(() => expect(closeMocks[0]).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(factoryCalls).toBe(2));
    releaseFactories[1]?.();

    await expect(tabsPromise).resolves.toHaveLength(2);
    expect(closeMocks[1]).not.toHaveBeenCalled();
  });

  it("holds ephemeral probes behind cancelled pending-session cleanup", async () => {
    let factoryCalls = 0;
    let releaseFactory!: () => void;
    let releaseClose!: () => void;
    const factoryGate = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const closeMocks: Array<ReturnType<typeof vi.fn>> = [];
    setChromeMcpSessionFactoryForTest(async () => {
      factoryCalls += 1;
      if (factoryCalls === 1) {
        await factoryGate;
      }
      const session = createFakeSession();
      const closeMock =
        factoryCalls === 1
          ? vi.fn(async () => {
              await closeGate;
            })
          : vi.fn().mockResolvedValue(undefined);
      closeMocks.push(closeMock);
      session.client.close = closeMock as typeof session.client.close;
      return session;
    });

    const ctrl = new AbortController();
    const cancelled = listChromeMcpTabs("chrome-live", undefined, { signal: ctrl.signal });
    const cancelledExpectation = expect(cancelled).rejects.toThrow("caller cancelled");
    await vi.waitFor(() => expect(factoryCalls).toBe(1));
    ctrl.abort(new Error("caller cancelled"));
    releaseFactory();
    await vi.waitFor(() => expect(closeMocks[0]).toHaveBeenCalledOnce());

    const probe = ensureChromeMcpAvailable("chrome-live", undefined, { ephemeral: true });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(factoryCalls).toBe(1);
    releaseClose();

    await cancelledExpectation;
    await expect(probe).resolves.toBeUndefined();
    expect(factoryCalls).toBe(2);
    expect(closeMocks[1]).toHaveBeenCalledOnce();
  });

  it("closes a shared pending session when every waiter aborts before ready", async () => {
    let factoryCalls = 0;
    let releaseReady: (() => void) | undefined;
    const readyGate = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    if (!releaseReady) {
      throw new Error("Expected Chrome MCP ready release callback to be initialized");
    }

    const closeMock = vi.fn().mockResolvedValue(undefined);
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      session.ready = readyGate;
      session.client.close = closeMock as typeof session.client.close;
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    const ctrl = new AbortController();
    const tabsPromise = listChromeMcpTabs("chrome-live", undefined, {
      signal: ctrl.signal,
    });
    const tabsExpectation = expect(tabsPromise).rejects.toThrow(/caller cancelled/);

    await vi.waitFor(() => expect(factoryCalls).toBe(1));
    ctrl.abort(new Error("caller cancelled"));
    releaseReady();

    await tabsExpectation;
    await vi.waitFor(() => expect(closeMock).toHaveBeenCalledTimes(1));
  });

  it("waits for last-waiter cleanup before starting a replacement session", async () => {
    let factoryCalls = 0;
    let releaseFirstClose: (() => void) | undefined;
    const firstCloseGate = new Promise<void>((resolve) => {
      releaseFirstClose = resolve;
    });
    if (!releaseFirstClose) {
      throw new Error("Expected Chrome MCP close release callback to be initialized");
    }

    const closeMocks: Array<ReturnType<typeof vi.fn>> = [];
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      const closeMock =
        factoryCalls === 1
          ? vi.fn(async () => {
              await firstCloseGate;
            })
          : vi.fn().mockResolvedValue(undefined);
      closeMocks.push(closeMock);
      session.client.close = closeMock as typeof session.client.close;
      if (factoryCalls === 1) {
        session.ready = new Promise<void>(() => {});
      }
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    const ctrl = new AbortController();
    const abortedTabsPromise = listChromeMcpTabs("chrome-live", undefined, {
      signal: ctrl.signal,
    });
    const abortedTabsExpectation = expect(abortedTabsPromise).rejects.toThrow(/caller cancelled/);

    await vi.waitFor(() => expect(factoryCalls).toBe(1));
    ctrl.abort(new Error("caller cancelled"));
    await vi.waitFor(() => expect(closeMocks[0]).toHaveBeenCalledTimes(1));

    const tabsPromise = listChromeMcpTabs("chrome-live");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(factoryCalls).toBe(1);

    releaseFirstClose();
    await abortedTabsExpectation;
    await vi.waitFor(() => expect(factoryCalls).toBe(2));
    await expect(tabsPromise).resolves.toHaveLength(2);
    expect(closeMocks[1]).not.toHaveBeenCalled();
  });

  it("keeps a ready-pending shared session cached when another waiter remains", async () => {
    let factoryCalls = 0;
    let releaseReady: (() => void) | undefined;
    const readyGate = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const readyThen = vi.spyOn(readyGate, "then");
    if (!releaseReady) {
      throw new Error("Expected Chrome MCP ready release callback to be initialized");
    }

    const closeMock = vi.fn().mockResolvedValue(undefined);
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      session.ready = readyGate;
      session.client.close = closeMock as typeof session.client.close;
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    const ctrl = new AbortController();
    const abortedTabsPromise = listChromeMcpTabs("chrome-live", undefined, {
      signal: ctrl.signal,
    });
    const abortedTabsExpectation =
      expect(abortedTabsPromise).rejects.toThrow(/first caller cancelled/);

    await vi.waitFor(() => expect(factoryCalls).toBe(1));
    await vi.waitFor(() => expect(readyThen).toHaveBeenCalledTimes(1));
    const keptCtrl = new AbortController();
    const tabsPromise = listChromeMcpTabs("chrome-live", undefined, {
      signal: keptCtrl.signal,
    });
    await vi.waitFor(() => expect(readyThen).toHaveBeenCalledTimes(2));
    ctrl.abort(new Error("first caller cancelled"));
    releaseReady();

    await abortedTabsExpectation;
    await expect(tabsPromise).resolves.toHaveLength(2);
    await expect(listChromeMcpTabs("chrome-live")).resolves.toHaveLength(2);
    expect(factoryCalls).toBe(1);
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("starts a fresh shared session when a ready-pending session loses its transport", async () => {
    let factoryCalls = 0;
    let firstSession: ChromeMcpSession | undefined;
    let releaseFirstReady: (() => void) | undefined;
    const firstReadyGate = new Promise<void>((resolve) => {
      releaseFirstReady = resolve;
    });
    const firstReadyThen = vi.spyOn(firstReadyGate, "then");
    if (!releaseFirstReady) {
      throw new Error("Expected Chrome MCP ready release callback to be initialized");
    }

    const closeMocks: Array<ReturnType<typeof vi.fn>> = [];
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      const closeMock = vi.fn().mockResolvedValue(undefined);
      closeMocks.push(closeMock);
      session.client.close = closeMock as typeof session.client.close;
      if (factoryCalls === 1) {
        firstSession = session;
        session.ready = firstReadyGate;
      }
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    const ctrl = new AbortController();
    const firstTabsPromise = listChromeMcpTabs("chrome-live", undefined, {
      signal: ctrl.signal,
    });
    const firstTabsExpectation = expect(firstTabsPromise).rejects.toThrow(/first waiter cancelled/);

    await vi.waitFor(() => expect(factoryCalls).toBe(1));
    await vi.waitFor(() => expect(firstReadyThen).toHaveBeenCalledTimes(1));
    if (!firstSession) {
      throw new Error("Expected first Chrome MCP session to be created");
    }
    (firstSession.transport as { pid: number | null }).pid = null;

    const tabsPromise = listChromeMcpTabs("chrome-live");
    const siblingTabsPromise = listChromeMcpTabs("chrome-live");
    ctrl.abort(new Error("first waiter cancelled"));
    releaseFirstReady();
    await vi.waitFor(() => expect(factoryCalls).toBe(2));
    const [tabs, siblingTabs] = await Promise.all([tabsPromise, siblingTabsPromise]);
    expect(tabs).toHaveLength(2);
    expect(siblingTabs).toHaveLength(2);

    await firstTabsExpectation;
    await vi.waitFor(() => expect(closeMocks[0]).toHaveBeenCalledTimes(1));
    expect(closeMocks[1]).not.toHaveBeenCalled();
  });

  it("surfaces startup failures before treating null-pid pending sessions as stale", async () => {
    let factoryCalls = 0;
    const closeMock = vi.fn().mockResolvedValue(undefined);
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      if (factoryCalls > 1) {
        throw new Error("unexpected retry");
      }
      const session = createFakeSession();
      (session.transport as { pid: number | null }).pid = null;
      const readyFailure = Promise.reject(new Error("startup failed"));
      readyFailure.catch(() => {});
      session.ready = readyFailure;
      session.client.close = closeMock as typeof session.client.close;
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    await expect(listChromeMcpTabs("chrome-live")).rejects.toThrow(/startup failed/);

    expect(factoryCalls).toBe(1);
    await vi.waitFor(() => expect(closeMock).toHaveBeenCalledTimes(1));
  });

  it("bounds retries when ready sessions keep losing their transport", async () => {
    let factoryCalls = 0;
    const closeMocks: Array<ReturnType<typeof vi.fn>> = [];
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      (session.transport as { pid: number | null }).pid = null;
      const closeMock = vi.fn().mockResolvedValue(undefined);
      closeMocks.push(closeMock);
      session.client.close = closeMock as typeof session.client.close;
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    await expect(listChromeMcpTabs("chrome-live")).rejects.toThrow(
      /subprocess exited before it became usable/,
    );

    expect(factoryCalls).toBe(2);
    await vi.waitFor(() => expect(closeMocks[0]).toHaveBeenCalled());
    await vi.waitFor(() => expect(closeMocks[1]).toHaveBeenCalled());
  });

  it("does not reuse a stale ready-pending session for ephemeral probes", async () => {
    let factoryCalls = 0;
    let firstSession: ChromeMcpSession | undefined;
    let releaseFirstReady: (() => void) | undefined;
    const firstReadyGate = new Promise<void>((resolve) => {
      releaseFirstReady = resolve;
    });
    const firstReadyThen = vi.spyOn(firstReadyGate, "then");
    if (!releaseFirstReady) {
      throw new Error("Expected Chrome MCP ready release callback to be initialized");
    }

    const closeMocks: Array<ReturnType<typeof vi.fn>> = [];
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      const closeMock = vi.fn().mockResolvedValue(undefined);
      closeMocks.push(closeMock);
      session.client.close = closeMock as typeof session.client.close;
      if (factoryCalls === 1) {
        firstSession = session;
        session.ready = firstReadyGate;
      }
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    const ctrl = new AbortController();
    const firstAvailablePromise = ensureChromeMcpAvailable("chrome-live", undefined, {
      signal: ctrl.signal,
    });
    const firstAvailableExpectation =
      expect(firstAvailablePromise).rejects.toThrow(/first waiter cancelled/);

    await vi.waitFor(() => expect(factoryCalls).toBe(1));
    await vi.waitFor(() => expect(firstReadyThen).toHaveBeenCalledTimes(1));
    if (!firstSession) {
      throw new Error("Expected first Chrome MCP session to be created");
    }
    (firstSession.transport as { pid: number | null }).pid = null;

    const availablePromise = ensureChromeMcpAvailable("chrome-live", undefined, {
      ephemeral: true,
    });
    ctrl.abort(new Error("first waiter cancelled"));
    releaseFirstReady();
    await expect(availablePromise).resolves.toBeUndefined();
    expect(factoryCalls).toBe(2);
    await vi.waitFor(() => expect(closeMocks[1]).toHaveBeenCalledTimes(1));

    await firstAvailableExpectation;
    await vi.waitFor(() => expect(closeMocks[0]).toHaveBeenCalledTimes(1));
  });

  it("does not let ephemeral probes persist canceled pending attaches", async () => {
    let factoryCalls = 0;
    let releaseFirstReady: (() => void) | undefined;
    const firstReadyGate = new Promise<void>((resolve) => {
      releaseFirstReady = resolve;
    });
    const firstReadyThen = vi.spyOn(firstReadyGate, "then");
    if (!releaseFirstReady) {
      throw new Error("Expected Chrome MCP ready release callback to be initialized");
    }

    const closeMocks: Array<ReturnType<typeof vi.fn>> = [];
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      const closeMock = vi.fn().mockResolvedValue(undefined);
      closeMocks.push(closeMock);
      session.client.close = closeMock as typeof session.client.close;
      if (factoryCalls === 1) {
        session.ready = firstReadyGate;
      }
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    const ctrl = new AbortController();
    const firstAvailablePromise = ensureChromeMcpAvailable("chrome-live", undefined, {
      signal: ctrl.signal,
    });
    const firstAvailableExpectation =
      expect(firstAvailablePromise).rejects.toThrow(/first waiter cancelled/);

    await vi.waitFor(() => expect(factoryCalls).toBe(1));
    await vi.waitFor(() => expect(firstReadyThen).toHaveBeenCalledTimes(1));

    await expect(
      ensureChromeMcpAvailable("chrome-live", undefined, {
        ephemeral: true,
      }),
    ).resolves.toBeUndefined();
    expect(factoryCalls).toBe(2);
    expect(firstReadyThen).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(closeMocks[1]).toHaveBeenCalledTimes(1));

    ctrl.abort(new Error("first waiter cancelled"));
    releaseFirstReady();
    await firstAvailableExpectation;
    await vi.waitFor(() => expect(closeMocks[0]).toHaveBeenCalledTimes(1));

    await expect(listChromeMcpTabs("chrome-live")).resolves.toHaveLength(2);
    expect(factoryCalls).toBe(3);
  });

  it("keeps a shared session after a readiness timeout while another waiter remains", async () => {
    let factoryCalls = 0;
    let releaseFirstReady: (() => void) | undefined;
    const firstReadyGate = new Promise<void>((resolve) => {
      releaseFirstReady = resolve;
    });
    const firstReadyThen = vi.spyOn(firstReadyGate, "then");
    if (!releaseFirstReady) {
      throw new Error("Expected Chrome MCP ready release callback to be initialized");
    }

    const closeMocks: Array<ReturnType<typeof vi.fn>> = [];
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      const closeMock = vi.fn().mockResolvedValue(undefined);
      closeMocks.push(closeMock);
      session.client.close = closeMock as typeof session.client.close;
      if (factoryCalls === 1) {
        session.ready = firstReadyGate;
      }
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    const keptCtrl = new AbortController();
    const timedOutTabsPromise = listChromeMcpTabs("chrome-live", undefined, {
      timeoutMs: 1,
    });
    const timedOutTabsExpectation = expect(timedOutTabsPromise).rejects.toThrow(/timed out/);
    const keptTabsPromise = listChromeMcpTabs("chrome-live", undefined, {
      signal: keptCtrl.signal,
    });

    await vi.waitFor(() => expect(factoryCalls).toBe(1));
    await vi.waitFor(() => expect(firstReadyThen).toHaveBeenCalledTimes(2));
    await timedOutTabsExpectation;

    const laterTabsPromise = listChromeMcpTabs("chrome-live");
    releaseFirstReady();

    await expect(keptTabsPromise).resolves.toHaveLength(2);
    await expect(laterTabsPromise).resolves.toHaveLength(2);
    expect(factoryCalls).toBe(1);
    expect(closeMocks[0]).not.toHaveBeenCalled();
    keptCtrl.abort(new Error("kept waiter cancelled"));
  });

  it("closes a shared pending session after a readiness timeout with no other waiters", async () => {
    let factoryCalls = 0;
    const closeMocks: Array<ReturnType<typeof vi.fn>> = [];
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      const closeMock = vi.fn().mockResolvedValue(undefined);
      closeMocks.push(closeMock);
      session.client.close = closeMock as typeof session.client.close;
      if (factoryCalls === 1) {
        session.ready = new Promise<void>(() => {});
      }
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    await expect(
      listChromeMcpTabs("chrome-live", undefined, {
        timeoutMs: 1,
      }),
    ).rejects.toThrow(/timed out/);
    await vi.waitFor(() => expect(closeMocks[0]).toHaveBeenCalledTimes(1));

    await expect(listChromeMcpTabs("chrome-live")).resolves.toHaveLength(2);
    expect(factoryCalls).toBe(2);
    expect(closeMocks[1]).not.toHaveBeenCalled();
  });

  it("preserves session after tool-level errors (isError)", async () => {
    let factoryCalls = 0;
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      const callTool = vi.fn(async ({ name }: ToolCall) => {
        if (name === "evaluate_script") {
          return {
            content: [{ type: "text", text: "element not found" }],
            isError: true,
          };
        }
        if (name === "list_pages") {
          return {
            content: [{ type: "text", text: "## Pages\n1: https://example.com [selected]" }],
          };
        }
        throw new Error(`unexpected tool ${name}`);
      });
      session.client.callTool = callTool as typeof session.client.callTool;
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    // First call: tool error (isError: true) — should NOT destroy session
    await expect(
      evaluateChromeMcpScript({
        profileName: "chrome-live",
        targetId: FAKE_TARGET_1,
        fn: "() => null",
      }),
    ).rejects.toThrow(/element not found/);

    // Second call: should reuse the same session (factory called only once)
    const tabs = await listChromeMcpTabs("chrome-live");
    expect(factoryCalls).toBe(1);
    expect(tabs).toHaveLength(1);
  });

  it("destroys session on transport errors so next call reconnects", async () => {
    let factoryCalls = 0;
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      if (factoryCalls === 1) {
        // First session: transport error (callTool throws)
        const callTool = vi.fn(async () => {
          throw new Error("connection reset");
        });
        session.client.callTool = callTool as typeof session.client.callTool;
      }
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    // First call: transport error — should destroy session
    await expect(listChromeMcpTabs("chrome-live")).rejects.toThrow(/connection reset/);

    // Second call: should create a new session (factory called twice)
    const tabs = await listChromeMcpTabs("chrome-live");
    expect(factoryCalls).toBe(2);
    expect(tabs).toHaveLength(2);
  });

  it("times out a stuck click and recovers on the next call", async () => {
    let factoryCalls = 0;
    let forwardedTimeout: number | undefined;
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      const callTool = vi.fn(
        async ({ name }: ToolCall, _resultSchema?: unknown, options?: { timeout?: number }) => {
          if (name === "click") {
            forwardedTimeout = options?.timeout;
            return await new Promise((_, reject) => {
              setTimeout(
                () => reject(new McpError(ErrorCode.RequestTimeout, "Request timed out")),
                options?.timeout,
              );
            });
          }
          if (name === "list_pages") {
            return {
              content: [{ type: "text", text: "## Pages\n1: https://example.com [selected]" }],
            };
          }
          throw new Error(`unexpected tool ${name}`);
        },
      );
      session.client.callTool = callTool as typeof session.client.callTool;
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    await expect(
      clickChromeMcpElement({
        profileName: "chrome-live",
        targetId: FAKE_TARGET_1,
        uid: FAKE_REF,
        timeoutMs: 25,
      }),
    ).rejects.toThrow(/timed out/i);

    expect(forwardedTimeout).toBe(25);
    const tabs = await listChromeMcpTabs("chrome-live");
    expect(factoryCalls).toBe(2);
    expect(tabs).toHaveLength(1);
  });

  it("cancels a stuck evaluate through the SDK signal and reconnects", async () => {
    let factoryCalls = 0;
    let forwardedSignal: AbortSignal | undefined;
    let notifyToolStarted: (() => void) | undefined;
    const toolStarted = new Promise<void>((resolve) => {
      notifyToolStarted = resolve;
    });
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      if (factoryCalls === 1) {
        session.client.callTool = vi.fn(
          async (_call: ToolCall, _resultSchema?: unknown, options?: { signal?: AbortSignal }) =>
            await new Promise((_resolve, reject) => {
              const signal = options?.signal;
              forwardedSignal = signal;
              notifyToolStarted?.();
              signal?.addEventListener(
                "abort",
                () => {
                  reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
                },
                {
                  once: true,
                },
              );
            }),
        ) as typeof session.client.callTool;
      }
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);
    const ctrl = new AbortController();
    const evaluatePromise = evaluateChromeMcpScript({
      profileName: "chrome-live",
      targetId: FAKE_TARGET_1,
      fn: "() => window.location.href",
      signal: ctrl.signal,
    });

    await toolStarted;
    expect(forwardedSignal).toBe(ctrl.signal);
    ctrl.abort(new Error("target browser crashed"));

    await expect(evaluatePromise).rejects.toThrow(/target browser crashed/i);
    await expect(listChromeMcpTabs("chrome-live")).resolves.toHaveLength(2);
    expect(factoryCalls).toBe(2);
  });

  it("does not dispatch a click when the signal is already aborted", async () => {
    const session = createFakeSession();
    const callTool = vi.fn(async (_call: ToolCall) => {
      throw new Error("callTool should not run");
    });
    session.client.callTool = callTool as typeof session.client.callTool;
    setChromeMcpSessionFactoryForTest(async () => session);
    const ctrl = new AbortController();
    ctrl.abort(new Error("aborted before click"));

    await expect(
      clickChromeMcpElement({
        profileName: "chrome-live",
        targetId: FAKE_TARGET_1,
        uid: FAKE_REF,
        signal: ctrl.signal,
      }),
    ).rejects.toThrow(/aborted before click/i);

    expect(callTool).not.toHaveBeenCalled();
  });

  it("creates a fresh session when userDataDir changes for the same profile", async () => {
    const createdSessions: ChromeMcpSession[] = [];
    const closeMocks: Array<ReturnType<typeof vi.fn>> = [];
    const factoryCalls: Array<{ profileName: string; userDataDir?: string }> = [];
    const factory: ChromeMcpSessionFactory = async (profileName, options) => {
      factoryCalls.push({ profileName, userDataDir: options?.userDataDir });
      const session = createFakeSession();
      const closeMock = vi.fn().mockResolvedValue(undefined);
      session.client.close = closeMock as typeof session.client.close;
      createdSessions.push(session);
      closeMocks.push(closeMock);
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    await listChromeMcpTabs("chrome-live", "/tmp/brave-a");
    await listChromeMcpTabs("chrome-live", "/tmp/brave-b");

    expect(factoryCalls).toEqual([
      { profileName: "chrome-live", userDataDir: "/tmp/brave-a" },
      { profileName: "chrome-live", userDataDir: "/tmp/brave-b" },
    ]);
    expect(createdSessions).toHaveLength(2);
    expect(closeMocks[0]).toHaveBeenCalledTimes(1);
    expect(closeMocks[1]).not.toHaveBeenCalled();
  });

  it("clears failed pending sessions so the next call can retry", async () => {
    let factoryCalls = 0;
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      if (factoryCalls === 1) {
        throw new Error("attach failed");
      }
      return createFakeSession();
    };
    setChromeMcpSessionFactoryForTest(factory);

    await expect(listChromeMcpTabs("chrome-live")).rejects.toThrow(/attach failed/);

    const tabs = await listChromeMcpTabs("chrome-live");
    expect(factoryCalls).toBe(2);
    expect(tabs).toHaveLength(2);
  });
  it("reconnects and retries list_pages once when Chrome MCP reports a stale selected page", async () => {
    let factoryCalls = 0;
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      session.client.callTool = vi.fn(async ({ name }: ToolCall) => {
        if (name !== "list_pages") {
          throw new Error(`unexpected tool ${name}`);
        }
        if (factoryCalls === 1) {
          return {
            content: [
              {
                type: "text",
                text: "The selected page has been closed. Call list_pages to see open pages.",
              },
            ],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: "## Pages\n1: https://example.com [selected]" }],
        };
      }) as typeof session.client.callTool;
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    const tabs = await listChromeMcpTabs("chrome-live");

    expect(factoryCalls).toBe(2);
    expect(tabs).toEqual([
      {
        targetId: FAKE_TARGET_1,
        title: "",
        url: "https://example.com",
        type: "page",
      },
    ]);
  });

  it("clears cached sessions after repeated stale selected-page failures", async () => {
    let factoryCalls = 0;
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      session.client.callTool = vi.fn(async ({ name }: ToolCall) => {
        if (name !== "list_pages") {
          throw new Error(`unexpected tool ${name}`);
        }
        if (factoryCalls <= 2) {
          return {
            content: [
              {
                type: "text",
                text: "The selected page has been closed. Call list_pages to see open pages.",
              },
            ],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: "## Pages\n1: https://example.com [selected]" }],
        };
      }) as typeof session.client.callTool;
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    await expect(listChromeMcpTabs("chrome-live")).rejects.toThrow(
      /The selected page has been closed/,
    );

    const tabs = await listChromeMcpTabs("chrome-live");

    expect(factoryCalls).toBe(3);
    expect(tabs).toHaveLength(1);
  });

  it("always passes a default timeout to navigate_page when none is specified", async () => {
    const session = createFakeSession();
    setChromeMcpSessionFactoryForTest(async () => session);

    await navigateChromeMcpPage({
      profileName: "chrome-live",
      targetId: FAKE_TARGET_1,
      url: "https://example.com",
      // intentionally no timeoutMs
    });

    const callToolMock = session.client["callTool"] as unknown as ToolCallMock;
    const navigateCall = callToolMock.mock.calls.find(
      ([call]) => call.name === "navigate_page",
    )?.[0];
    expect(navigateCall?.arguments?.timeout).toBe(20_000);
  });

  it("caps the navigate_page safety-net timeout", () => {
    expect(resolveChromeMcpNavigateCallTimeoutMs(10_000)).toBe(15_000);
    expect(resolveChromeMcpNavigateCallTimeoutMs(Number.MAX_VALUE)).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("resets the Chrome MCP session when a navigate_page call hangs past the safety-net timeout", async () => {
    vi.useFakeTimers();
    let factoryCalls = 0;
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      if (factoryCalls === 1) {
        const timeoutCall = createSdkTimeoutCallTool();
        session.client.callTool = vi.fn(
          async (call: ToolCall, resultSchema?: unknown, options?: { timeout?: number }) => {
            if (call.name === "list_pages") {
              return fakeListPagesResult();
            }
            return await timeoutCall(call, resultSchema, options);
          },
        ) as typeof session.client.callTool;
      }
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    // Start navigation — will hang.
    const navPromise = navigateChromeMcpPage({
      profileName: "chrome-live",
      targetId: FAKE_TARGET_1,
      url: "https://slow-site.example",
    });
    // Suppress unhandled-rejection detection: navPromise rejects during timer
    // advancement, before the expect below attaches its handler.
    void navPromise.catch(() => {});

    // Advance past the 25 s safety-net (CHROME_MCP_NAVIGATE_TIMEOUT_MS 20 s + 5 s buffer).
    await vi.advanceTimersByTimeAsync(25_001);

    await expect(navPromise).rejects.toThrow(/Chrome MCP "navigate_page".*timed out/);

    // Switch back to real timers before testing reconnect behaviour.
    vi.useRealTimers();

    // Next call must use a fresh session — factory is called a second time.
    const tabs = await listChromeMcpTabs("chrome-live");
    expect(factoryCalls).toBe(2);
    expect(tabs).toHaveLength(2);
  });

  it("forwards an explicit timeoutMs to take_snapshot through the SDK", async () => {
    vi.useFakeTimers();
    const session = createFakeSession();
    const timeoutCall = createSdkTimeoutCallTool();
    session.client.callTool = vi.fn(
      async (call: ToolCall, resultSchema?: unknown, options?: { timeout?: number }) => {
        if (call.name === "list_pages") {
          return fakeListPagesResult();
        }
        return await timeoutCall(call, resultSchema, options);
      },
    ) as typeof session.client.callTool;
    setChromeMcpSessionFactoryForTest(async () => session);

    const snapshotPromise = takeChromeMcpSnapshot({
      profileName: "chrome-live",
      targetId: FAKE_TARGET_1,
      timeoutMs: 75,
    });
    void snapshotPromise.catch(() => {});

    await vi.advanceTimersByTimeAsync(75);

    await expect(snapshotPromise).rejects.toThrow(/Chrome MCP "take_snapshot".*timed out/);
    vi.useRealTimers();
  });

  it("honors timeoutMs for ephemeral availability probes", async () => {
    vi.useFakeTimers();
    const closeMock = vi.fn().mockResolvedValue(undefined);
    const factory: ChromeMcpSessionFactory = async () =>
      ({
        client: {
          callTool: vi.fn(),
          listTools: vi.fn(),
          close: closeMock,
          connect: vi.fn(),
        },
        transport: {
          pid: 123,
        },
        ready: new Promise<void>(() => {}),
      }) as unknown as ChromeMcpSession;
    setChromeMcpSessionFactoryForTest(factory);

    const promise = ensureChromeMcpAvailable("chrome-live", undefined, {
      ephemeral: true,
      timeoutMs: 50,
    });
    const expectation = expect(promise).rejects.toThrow(/timed out after 50ms/i);

    await vi.advanceTimersByTimeAsync(50);

    await expectation;
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("redacts home-relative profile labels from availability timeout diagnostics", async () => {
    vi.useFakeTimers();
    const closeMock = vi.fn().mockResolvedValue(undefined);
    const factory: ChromeMcpSessionFactory = async () =>
      ({
        client: {
          callTool: vi.fn(),
          listTools: vi.fn(),
          close: closeMock,
          connect: vi.fn(),
        },
        transport: {
          pid: 123,
        },
        ready: new Promise<void>(() => {}),
      }) as unknown as ChromeMcpSession;
    setChromeMcpSessionFactoryForTest(factory);

    const homeDir = os.homedir();
    const profileName = path.join(homeDir, "Library", "Application Support", "Google", "Chrome");
    const promise = ensureChromeMcpAvailable(profileName, undefined, {
      ephemeral: true,
      timeoutMs: 50,
    });
    void promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(50);

    await expect(promise).rejects.toThrow(/timed out after 50ms/i);
    await expect(promise).rejects.toThrow("~/Library/Application Support/Google/Chrome");
    await expect(promise).rejects.not.toThrow(homeDir);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("honors abort signals while waiting for ephemeral availability probes", async () => {
    const closeMock = vi.fn().mockResolvedValue(undefined);
    const factory: ChromeMcpSessionFactory = vi.fn(
      async () =>
        ({
          client: {
            callTool: vi.fn(),
            listTools: vi.fn(),
            close: closeMock,
            connect: vi.fn(),
          },
          transport: {
            pid: 123,
          },
          ready: new Promise<void>(() => {}),
        }) as unknown as ChromeMcpSession,
    );
    setChromeMcpSessionFactoryForTest(factory);

    const ctrl = new AbortController();
    const promise = ensureChromeMcpAvailable("chrome-live", undefined, {
      ephemeral: true,
      signal: ctrl.signal,
    });
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
    ctrl.abort(new Error("status budget exhausted"));

    await expect(promise).rejects.toThrow(/status budget exhausted/);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});
