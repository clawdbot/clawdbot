import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clickChromeMcpCoords,
  clickChromeMcpElement,
  buildChromeMcpArgs,
  decodeChromeMcpStderrTail,
  ensureChromeMcpAvailable,
  evaluateChromeMcpScript,
  listChromeMcpTabs,
  navigateChromeMcpPage,
  openChromeMcpTab,
  resolveChromeMcpNavigateCallTimeoutMs,
  resetChromeMcpSessionsForTest,
  setChromeMcpProcessCleanupDepsForTest,
  setChromeMcpSessionFactoryForTest,
  takeChromeMcpScreenshot,
  takeChromeMcpSnapshot,
} from "./chrome-mcp.js";

type ToolCall = {
  name: string;
  arguments?: Record<string, unknown>;
};
type ToolCallMock = {
  mock: {
    calls: Array<[ToolCall]>;
  };
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

  it("reads screenshot files with the extension written by chrome-devtools-mcp", async () => {
    const factory: ChromeMcpSessionFactory = async () => createFakeSession();
    setChromeMcpSessionFactoryForTest(factory);

    await expect(
      takeChromeMcpScreenshot({
        profileName: "chrome-live",
        targetId: "1",
        format: "jpeg",
      }),
    ).resolves.toEqual(Buffer.from("screenshot:jpeg"));
  });

  it("adds --userDataDir when an explicit Chromium profile path is configured", () => {
    expect(buildChromeMcpArgs("/tmp/brave-profile")).toEqual([
      "-y",
      "chrome-devtools-mcp@latest",
      "--autoConnect",
      "--no-usage-statistics",
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
      "--no-usage-statistics",
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
      "--no-usage-statistics",
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

  it("lets explicit Chrome MCP usage-statistics args override the default opt-out", () => {
    expect(
      buildChromeMcpArgs({
        mcpArgs: ["--usage-statistics"],
      }),
    ).toEqual([
      "-y",
      "chrome-devtools-mcp@latest",
      "--autoConnect",
      "--experimentalStructuredContent",
      "--experimental-page-id-routing",
      "--usage-statistics",
    ]);
  });

  it("does not duplicate an explicit Chrome MCP usage-statistics opt-out", () => {
    expect(
      buildChromeMcpArgs({
        mcpArgs: ["--no-usage-statistics"],
      }),
    ).toEqual([
      "-y",
      "chrome-devtools-mcp@latest",
      "--autoConnect",
      "--experimentalStructuredContent",
      "--experimental-page-id-routing",
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
      "--no-usage-statistics",
      "--experimentalStructuredContent",
      "--experimental-page-id-routing",
    ]);
  });

  it("terminates the owned Chrome MCP subprocess tree when closing temporary sessions", async () => {
    const session = createFakeSession();
    Object.assign(session, { ownsProcessTree: true });
    const closeMock = vi.fn().mockResolvedValue(undefined);
    session.client.close = closeMock as typeof session.client.close;
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    setChromeMcpProcessCleanupDepsForTest({
      platform: "linux",
      listProcesses: vi.fn().mockResolvedValue([
        { pid: 123, ppid: 1 },
        { pid: 124, ppid: 123 },
        { pid: 125, ppid: 124 },
        { pid: 126, ppid: 1 },
      ]),
      killProcess: (pid, signal) => {
        killCalls.push({ pid, signal });
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

  it("uses Windows taskkill tree cleanup without waiting for SDK stdio close timeout", async () => {
    const session = createFakeSession();
    Object.assign(session, { ownsProcessTree: true });
    const closeOrder: string[] = [];
    session.client.close = vi.fn(async () => {
      closeOrder.push("client.close");
    }) as typeof session.client.close;
    setChromeMcpProcessCleanupDepsForTest({
      platform: "win32",
      taskkillProcessTree: vi.fn(async (pid) => {
        closeOrder.push(`taskkill:${pid}`);
      }),
    });
    setChromeMcpSessionFactoryForTest(async () => session);

    await ensureChromeMcpAvailable("chrome-live", undefined, { ephemeral: true });

    expect(closeOrder).toEqual(["taskkill:123"]);
  });

  it("falls back to SDK stdio close when Windows taskkill cleanup fails", async () => {
    const session = createFakeSession();
    Object.assign(session, { ownsProcessTree: true });
    const closeMock = vi.fn().mockResolvedValue(undefined);
    session.client.close = closeMock as typeof session.client.close;
    setChromeMcpProcessCleanupDepsForTest({
      platform: "win32",
      taskkillProcessTree: vi.fn().mockRejectedValue(new Error("taskkill failed")),
    });
    setChromeMcpSessionFactoryForTest(async () => session);

    await ensureChromeMcpAvailable("chrome-live", undefined, { ephemeral: true });

    expect(closeMock).toHaveBeenCalledTimes(1);
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
    expect(session.client["callTool"]).toHaveBeenCalledWith({
      name: "new_page",
      arguments: { url: "about:blank", timeout: 5000 },
    });
    const callToolMock = session.client["callTool"] as unknown as ToolCallMock;
    const callNames = callToolMock.mock.calls.map(([call]) => call.name);
    expect(callNames).not.toContain("navigate_page");
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

  it("defaults non-finite coordinate click delays before injecting the browser script", async () => {
    const session = createFakeSession();
    const callTool = vi.fn(async ({ name }: ToolCall) => {
      if (name === "evaluate_script") {
        return { content: [{ type: "text", text: "```json\nnull\n```" }] };
      }
      throw new Error(`unexpected tool ${name}`);
    });
    session.client.callTool = callTool as typeof session.client.callTool;
    setChromeMcpSessionFactoryForTest(async () => session);

    await clickChromeMcpCoords({
      profileName: "chrome-live",
      targetId: "1",
      x: 10,
      y: 20,
      delayMs: Number.NaN,
    });

    const callToolMock = callTool as unknown as ToolCallMock;
    const evaluateCall = callToolMock.mock.calls.find(([call]) => call.name === "evaluate_script");
    const fn = evaluateCall?.[0].arguments?.function;
    expect(typeof fn === "string" ? fn : "").toContain("const delayMs = 0;");
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
      targetId: "1",
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

  it("starts a fresh shared session after every waiter aborts a pending attach", async () => {
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
    await abortedTabsExpectation;

    const tabsPromise = listChromeMcpTabs("chrome-live");
    await vi.waitFor(() => expect(factoryCalls).toBe(2));
    releaseFactories[0]?.();
    releaseFactories[1]?.();

    await expect(tabsPromise).resolves.toHaveLength(2);
    await vi.waitFor(() => expect(closeMocks[0]).toHaveBeenCalledTimes(1));
    expect(closeMocks[1]).not.toHaveBeenCalled();
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

  it("starts a fresh session while last-waiter abort cleanup is closing", async () => {
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
    await vi.waitFor(() => expect(factoryCalls).toBe(2));
    await expect(tabsPromise).resolves.toHaveLength(2);
    expect(closeMocks[1]).not.toHaveBeenCalled();

    releaseFirstClose();
    await abortedTabsExpectation;
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

  it("forwards an explicit timeoutMs to take_snapshot via the callTool race", async () => {
    vi.useFakeTimers();
    const session = createFakeSession();
    session.client.callTool = vi.fn(
      async () => new Promise<never>(() => {}),
    ) as typeof session.client.callTool;
    setChromeMcpSessionFactoryForTest(async () => session);

    const snapshotPromise = takeChromeMcpSnapshot({
      profileName: "chrome-live",
      targetId: "1",
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

    const ctrl = new AbortController();
    const promise = ensureChromeMcpAvailable("chrome-live", undefined, {
      ephemeral: true,
      signal: ctrl.signal,
    });
    ctrl.abort(new Error("status budget exhausted"));

    await expect(promise).rejects.toThrow(/status budget exhausted/);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});
