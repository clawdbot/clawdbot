import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clickChromeMcpElement,
  buildChromeMcpArgs,
  ensureChromeMcpAvailable,
  evaluateChromeMcpScript,
  listChromeMcpTabs,
  navigateChromeMcpPage,
  openChromeMcpTab,
  resetChromeMcpSessionsForTest,
  setChromeMcpSessionFactoryForTest,
} from "./chrome-mcp.js";

type ToolCall = {
  name: string;
  arguments?: Record<string, unknown>;
};

type ChromeMcpSessionFactory = Exclude<
  Parameters<typeof setChromeMcpSessionFactoryForTest>[0],
  null
>;
type ChromeMcpSession = Awaited<ReturnType<ChromeMcpSessionFactory>>;

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
  } as unknown as ChromeMcpSession;
}

describe("chrome MCP page parsing", () => {
  beforeEach(async () => {
    await resetChromeMcpSessionsForTest();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("parses list_pages text responses when structuredContent is missing", async () => {
    const factory: ChromeMcpSessionFactory = async () => createFakeSession();
    setChromeMcpSessionFactoryForTest(factory);

    const tabs = await listChromeMcpTabs("chrome-live");

    expect(tabs).toEqual([
      {
        targetId: "1",
        title: "",
        url: "https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session",
        type: "page",
      },
      {
        targetId: "2",
        title: "",
        url: "https://github.com/openclaw/openclaw/pull/45318",
        type: "page",
      },
    ]);
  });

  it("adds --userDataDir when an explicit Chromium profile path is configured", () => {
    expect(buildChromeMcpArgs("/tmp/brave-profile")).toEqual([
      "-y",
      "chrome-devtools-mcp@latest",
      "--autoConnect",
      "--experimentalStructuredContent",
      "--experimental-page-id-routing",
      "--userDataDir",
      "/tmp/brave-profile",
    ]);
  });

  it("uses browserUrl for existing-session cdpUrl without also passing userDataDir", () => {
    expect(
      buildChromeMcpArgs({
        cdpUrl: "http://127.0.0.1:9222",
        userDataDir: "/tmp/brave-profile",
      }),
    ).toEqual([
      "-y",
      "chrome-devtools-mcp@latest",
      "--browserUrl",
      "http://127.0.0.1:9222",
      "--experimentalStructuredContent",
      "--experimental-page-id-routing",
    ]);
  });

  it("uses wsEndpoint for direct existing-session websocket cdpUrl", () => {
    expect(
      buildChromeMcpArgs({
        cdpUrl: "ws://127.0.0.1:9222/devtools/browser/abc",
      }),
    ).toEqual([
      "-y",
      "chrome-devtools-mcp@latest",
      "--wsEndpoint",
      "ws://127.0.0.1:9222/devtools/browser/abc",
      "--experimentalStructuredContent",
      "--experimental-page-id-routing",
    ]);
  });

  it("appends custom Chrome MCP args and lets explicit endpoint args override auto-connect", () => {
    expect(
      buildChromeMcpArgs({
        userDataDir: "/tmp/brave-profile",
        mcpArgs: ["--browserUrl", "http://127.0.0.1:9222", "--no-usage-statistics"],
      }),
    ).toEqual([
      "-y",
      "chrome-devtools-mcp@latest",
      "--experimentalStructuredContent",
      "--experimental-page-id-routing",
      "--browserUrl",
      "http://127.0.0.1:9222",
      "--no-usage-statistics",
    ]);
  });

  it("omits the npx package prefix for a custom Chrome MCP command", () => {
    expect(
      buildChromeMcpArgs({
        mcpCommand: "/usr/local/bin/chrome-devtools-mcp",
        cdpUrl: "http://127.0.0.1:9222",
      }),
    ).toEqual([
      "--browserUrl",
      "http://127.0.0.1:9222",
      "--experimentalStructuredContent",
      "--experimental-page-id-routing",
    ]);
  });

  it("parses new_page text responses and returns the created tab", async () => {
    const factory: ChromeMcpSessionFactory = async () => createFakeSession();
    setChromeMcpSessionFactoryForTest(factory);

    const tab = await openChromeMcpTab("chrome-live", "https://example.com/");

    expect(tab).toEqual({
      targetId: "3",
      title: "",
      url: "https://example.com/",
      type: "page",
    });
  });

  it("opens about:blank directly without an extra navigate", async () => {
    const session = createFakeSession();
    const factory: ChromeMcpSessionFactory = async () => session;
    setChromeMcpSessionFactoryForTest(factory);

    const tab = await openChromeMcpTab("chrome-live", "about:blank");

    expect(tab).toEqual({
      targetId: "3",
      title: "",
      url: "about:blank",
      type: "page",
    });
    expect(session.client.callTool).toHaveBeenCalledWith({
      name: "new_page",
      arguments: { url: "about:blank", timeout: 5000 },
    });
    expect(session.client.callTool).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "navigate_page" }),
    );
  });

  it("parses evaluate_script text responses when structuredContent is missing", async () => {
    const factory: ChromeMcpSessionFactory = async () => createFakeSession();
    setChromeMcpSessionFactoryForTest(factory);

    const result = await evaluateChromeMcpScript({
      profileName: "chrome-live",
      targetId: "1",
      fn: "() => 123",
    });

    expect(result).toBe(123);
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
      listChromeMcpTabs("chrome-live", undefined, {
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
        targetId: "1",
        fn: "() => document.getElementById('missing').value",
      }),
    ).rejects.toThrow(/Cannot read properties of null/);
  });

  it("reuses a single pending session for concurrent requests", async () => {
    let factoryCalls = 0;
    let releaseFactory!: () => void;
    const factoryGate = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });

    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      await factoryGate;
      return createFakeSession();
    };
    setChromeMcpSessionFactoryForTest(factory);

    const tabsPromise = listChromeMcpTabs("chrome-live");
    const evalPromise = evaluateChromeMcpScript({
      profileName: "chrome-live",
      targetId: "1",
      fn: "() => 123",
    });

    releaseFactory();
    const [tabs, result] = await Promise.all([tabsPromise, evalPromise]);

    expect(factoryCalls).toBe(1);
    expect(tabs).toHaveLength(2);
    expect(result).toBe(123);
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
      evaluateChromeMcpScript({ profileName: "chrome-live", targetId: "1", fn: "() => null" }),
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
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      const callTool = vi.fn(async ({ name }: ToolCall) => {
        if (name === "click") {
          return await new Promise(() => {});
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

    await expect(
      clickChromeMcpElement({
        profileName: "chrome-live",
        targetId: "1",
        uid: "btn-1",
        timeoutMs: 25,
      }),
    ).rejects.toThrow(/timed out/i);

    const tabs = await listChromeMcpTabs("chrome-live");
    expect(factoryCalls).toBe(2);
    expect(tabs).toHaveLength(1);
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
        targetId: "1",
        uid: "btn-1",
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
        targetId: "1",
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
      targetId: "1",
      url: "https://example.com",
      // intentionally no timeoutMs
    });

    expect(session.client.callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "navigate_page",
        arguments: expect.objectContaining({ timeout: 20_000 }),
      }),
    );
  });

  it("resets the Chrome MCP session when a navigate_page call hangs past the safety-net timeout", async () => {
    vi.useFakeTimers();
    let factoryCalls = 0;
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      if (factoryCalls === 1) {
        // First session: all tool calls hang — simulates a Chrome MCP subprocess that is
        // completely blocked (e.g., stuck waiting for a slow navigation to complete).
        session.client.callTool = vi.fn(
          async () => new Promise<never>(() => {}),
        ) as typeof session.client.callTool;
      }
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    // Start navigation — will hang.
    const navPromise = navigateChromeMcpPage({
      profileName: "chrome-live",
      targetId: "1",
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
});
