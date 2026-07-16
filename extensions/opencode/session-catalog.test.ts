import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";

const nodeHostMocks = vi.hoisted(() => ({
  runNodePtyCommand: vi.fn(async () => ({ exitCode: 0 })),
}));
const childProcessMocks = vi.hoisted(() => ({
  children: [] as ChildProcess[],
  spawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  childProcessMocks.spawn.mockImplementation((...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args);
    childProcessMocks.children.push(child);
    return child;
  });
  return { ...actual, spawn: childProcessMocks.spawn };
});

vi.mock("openclaw/plugin-sdk/node-host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/node-host")>();
  return {
    ...actual,
    runNodePtyCommand: nodeHostMocks.runNodePtyCommand,
    resolveNodeHostExecutable: (
      command: string,
      options: {
        env?: NodeJS.ProcessEnv;
        pathEnv?: string;
        includeExtensionless?: boolean;
      },
    ) => {
      const env = options.env ?? process.env;
      return actual.resolveNodeHostExecutable(command, {
        env,
        pathEnv: options.pathEnv ?? env.PATH ?? env.Path ?? "",
        includeExtensionless: options.includeExtensionless,
        strategy: "direct",
      });
    },
  };
});

import { registerOpenCodeSessionCatalog } from "./session-catalog-plugin.js";
import {
  OPENCODE_SESSIONS_LIST_COMMAND,
  OPENCODE_SESSION_READ_COMMAND,
  OPENCODE_TERMINAL_RESUME_COMMAND,
} from "./session-catalog-shared.js";
import {
  listLocalOpenCodeSessionPage,
  readLocalOpenCodeTranscriptPage,
} from "./session-catalog.js";

const temporaryDirectories: string[] = [];
const originalPath = process.env.PATH;
const originalPathExt = process.env.PATHEXT;
const originalUnrelatedEnv = process.env.CATALOG_UNRELATED_ENV;

function captureOpenCodeSessionRegistrations(pluginConfig: unknown = {}) {
  const catalogs: Array<Parameters<OpenClawPluginApi["registerSessionCatalog"]>[0]> = [];
  const commands: Array<Parameters<OpenClawPluginApi["registerNodeHostCommand"]>[0]> = [];
  const policies: Array<Parameters<OpenClawPluginApi["registerNodeInvokePolicy"]>[0]> = [];
  registerOpenCodeSessionCatalog({
    pluginConfig,
    runtime: { nodes: { list: vi.fn().mockResolvedValue({ nodes: [] }) } },
    registerSessionCatalog: (catalog: Parameters<OpenClawPluginApi["registerSessionCatalog"]>[0]) =>
      catalogs.push(catalog),
    registerNodeHostCommand: (
      command: Parameters<OpenClawPluginApi["registerNodeHostCommand"]>[0],
    ) => commands.push(command),
    registerNodeInvokePolicy: (
      policy: Parameters<OpenClawPluginApi["registerNodeInvokePolicy"]>[0],
    ) => policies.push(policy),
  } as unknown as OpenClawPluginApi);
  return { catalogs, commands, policies };
}

async function installFakeOpenCode(
  assistantText = "hi",
  sessionTitle = "Catalog session",
): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-opencode-catalog-"));
  temporaryDirectories.push(directory);
  const executable = path.join(directory, "opencode");
  const session = {
    id: "ses_test",
    title: sessionTitle,
    created: 1_700_000_000_000,
    updated: 1_700_000_001_000,
    projectId: "project",
    directory: "/workspace",
  };
  const exported = {
    info: session,
    messages: [
      {
        info: {
          id: "msg_user",
          role: "user",
          time: { created: 1_700_000_000_000 },
          model: { providerID: "anthropic", modelID: "claude" },
        },
        parts: [{ id: "prt_user", type: "text", text: "hello" }],
      },
      {
        info: {
          id: "msg_assistant",
          role: "assistant",
          time: { created: 1_700_000_001_000 },
          providerID: "anthropic",
          modelID: "claude",
        },
        parts: [
          { id: "prt_reason", type: "reasoning", text: "thinking" },
          { id: "prt_answer", type: "text", text: assistantText },
          {
            id: "prt_tool",
            type: "tool",
            tool: "bash",
            state: { status: "completed", input: { command: "pwd" }, output: "/workspace" },
          },
        ],
      },
    ],
  };
  await fs.writeFile(
    executable,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (process.env.CATALOG_UNRELATED_ENV) process.exit(3);
if (args[0] === "--pure" && args[1] === "db" && args.includes("--format") && args.includes("json")) {
  process.stdout.write(${JSON.stringify(JSON.stringify([session]))});
} else if (args[0] === "--pure" && args[1] === "export" && args[2] === "ses_test") {
  process.stdout.write(${JSON.stringify(JSON.stringify(exported))});
} else {
  process.exitCode = 2;
}
`,
  );
  await fs.chmod(executable, 0o755);
  process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ""}`;
  process.env.CATALOG_UNRELATED_ENV = "present";
  return directory;
}

async function installHangingOpenCode(): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-opencode-stream-"));
  temporaryDirectories.push(directory);
  const executableName = process.platform === "win32" ? "opencode.js" : "opencode";
  await fs.writeFile(
    path.join(directory, executableName),
    `${process.platform === "win32" ? "" : "#!/usr/bin/env node\n"}setTimeout(() => process.stdout.write("ready\\n"), 50);
setInterval(() => {}, 1_000);
`,
  );
  if (process.platform !== "win32") {
    await fs.chmod(path.join(directory, executableName), 0o755);
  }
  process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ""}`;
  if (process.platform === "win32") {
    // The production resolver converts a PATHEXT-resolved .js command into
    // process.execPath plus the script path, so this remains a direct real-child spawn.
    process.env.PATHEXT = `.JS;${originalPathExt ?? ".EXE;.CMD;.BAT;.COM"}`;
  }
}

function isProcessRunning(pid: number | undefined): boolean {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || !isProcessRunning(child.pid)) {
    return;
  }
  const closed = once(child, "close");
  child.kill("SIGKILL");
  await closed;
}

afterEach(async () => {
  nodeHostMocks.runNodePtyCommand.mockClear();
  childProcessMocks.spawn.mockClear();
  await Promise.all(childProcessMocks.children.splice(0).map((child) => stopChild(child)));
  process.env.PATH = originalPath;
  if (originalPathExt === undefined) {
    delete process.env.PATHEXT;
  } else {
    process.env.PATHEXT = originalPathExt;
  }
  if (originalUnrelatedEnv === undefined) {
    delete process.env.CATALOG_UNRELATED_ENV;
  } else {
    process.env.CATALOG_UNRELATED_ENV = originalUnrelatedEnv;
  }
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("OpenCode session catalog", () => {
  it.runIf(process.platform !== "win32")(
    "lists and reads sessions through the official CLI JSON surfaces",
    async () => {
      await installFakeOpenCode();
      const listed = await listLocalOpenCodeSessionPage({ limit: 20 });
      expect(listed).toEqual({
        sessions: [
          expect.objectContaining({
            threadId: "ses_test",
            name: "Catalog session",
            cwd: "/workspace",
            source: "opencode-cli",
            canContinue: false,
          }),
        ],
      });

      const transcript = await readLocalOpenCodeTranscriptPage({
        threadId: "ses_test",
        limit: 20,
      });
      expect(transcript.items.map((item) => [item.type, item.text])).toEqual([
        ["userMessage", "hello"],
        ["reasoning", "thinking"],
        ["agentMessage", "hi"],
        ["toolCall", 'bash\n{"command":"pwd"}'],
        ["toolResult", "/workspace"],
      ]);
      const itemIds = transcript.items.flatMap((item) => (item.id ? [item.id] : []));
      expect(new Set(itemIds).size).toBe(itemIds.length);

      const latest = await readLocalOpenCodeTranscriptPage({ threadId: "ses_test", limit: 2 });
      expect(latest.items.map((item) => item.type)).toEqual(["toolCall", "toolResult"]);
      expect(latest.nextCursor).toBeTruthy();
      const older = await readLocalOpenCodeTranscriptPage({
        threadId: "ses_test",
        limit: 2,
        cursor: latest.nextCursor,
      });
      expect(older.items.map((item) => item.type)).toEqual(["reasoning", "agentMessage"]);
      await expect(listLocalOpenCodeSessionPage({ cursor: " " })).rejects.toThrow(
        "cursor is invalid",
      );
      await expect(
        readLocalOpenCodeTranscriptPage({ threadId: "ses_test", cursor: 123 }),
      ).rejects.toThrow("cursor is invalid");
      await expect(readLocalOpenCodeTranscriptPage({ threadId: "--help" })).rejects.toThrow(
        "threadId is invalid",
      );

      let provider: Parameters<OpenClawPluginApi["registerSessionCatalog"]>[0] | undefined;
      registerOpenCodeSessionCatalog({
        pluginConfig: {},
        runtime: { nodes: { list: vi.fn().mockResolvedValue({ nodes: [] }) } },
        registerSessionCatalog: (value: NonNullable<typeof provider>) => {
          provider = value;
        },
        registerNodeHostCommand: vi.fn(),
        registerNodeInvokePolicy: vi.fn(),
      } as unknown as OpenClawPluginApi);
      await expect(
        provider!.read({ hostId: "gateway", threadId: "ses_test", limit: 2 }),
      ).resolves.toMatchObject({ threadId: "ses_test", items: expect.any(Array) });
      await expect(provider!.list({})).resolves.toEqual([
        expect.objectContaining({ hostId: "gateway", sessions: [expect.any(Object)] }),
      ]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps oversized transcript items below the node payload budget",
    async () => {
      await installFakeOpenCode("x".repeat(600 * 1024));
      const transcript = await readLocalOpenCodeTranscriptPage({
        threadId: "ses_test",
        limit: 20,
      });
      const answer = transcript.items.find((item) => item.type === "agentMessage");
      expect(answer?.text?.endsWith("…")).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(transcript), "utf8")).toBeLessThan(20 * 1024 * 1024);
    },
  );

  it.runIf(process.platform !== "win32")(
    "auto-detects the CLI and honors the node-local Web UI switch",
    async () => {
      const directory = await installFakeOpenCode();
      const { commands } = captureOpenCodeSessionRegistrations();
      expect(commands.map((command) => command.command)).toEqual([
        OPENCODE_SESSIONS_LIST_COMMAND,
        OPENCODE_SESSION_READ_COMMAND,
        OPENCODE_TERMINAL_RESUME_COMMAND,
      ]);
      expect(
        commands.every((command) =>
          command.isAvailable?.({ config: {}, env: { PATH: directory } } as never),
        ),
      ).toBe(true);
      expect(
        commands.every((command) =>
          command.isAvailable?.({
            config: {
              plugins: {
                entries: { opencode: { config: { sessionCatalog: { enabled: false } } } },
              },
            },
            env: { PATH: directory },
          } as never),
        ),
      ).toBe(false);
      expect(
        commands.every((command) =>
          command.isAvailable?.({
            config: {},
            env: { PATH: path.join(directory, "missing") },
          } as never),
        ),
      ).toBe(false);
    },
  );

  it.runIf(process.platform !== "win32")(
    "opens validated local sessions with the upstream terminal resume contract",
    async () => {
      await installFakeOpenCode();
      let provider: Parameters<OpenClawPluginApi["registerSessionCatalog"]>[0] | undefined;
      registerOpenCodeSessionCatalog({
        pluginConfig: {},
        runtime: { nodes: { list: vi.fn().mockResolvedValue({ nodes: [] }) } },
        registerSessionCatalog: (value: NonNullable<typeof provider>) => {
          provider = value;
        },
        registerNodeHostCommand: vi.fn(),
        registerNodeInvokePolicy: vi.fn(),
      } as unknown as OpenClawPluginApi);

      await expect(provider!.list({ hostIds: ["gateway"] })).resolves.toEqual([
        expect.objectContaining({
          sessions: [expect.objectContaining({ threadId: "ses_test", canOpenTerminal: true })],
        }),
      ]);
      await expect(
        provider!.openTerminal!({ hostId: "gateway", threadId: "ses_test" }),
      ).resolves.toEqual({
        kind: "local",
        argv: [expect.stringMatching(/opencode$/u), "--session", "ses_test"],
        cwd: "/workspace",
        title: "opencode --session ses_test…",
      });
      await expect(
        provider!.openTerminal!({ hostId: "gateway", threadId: "missing" }),
      ).rejects.toThrow("OpenCode session is unavailable");
    },
  );

  it.runIf(process.platform !== "win32")(
    "runs only catalog-validated OpenCode sessions through the node PTY",
    async () => {
      await installFakeOpenCode();
      const { commands, policies } = captureOpenCodeSessionRegistrations();
      const terminal = commands.find(
        (command) => command.command === OPENCODE_TERMINAL_RESUME_COMMAND,
      );
      const io = {
        signal: new AbortController().signal,
        onInput: vi.fn(),
        emitChunk: vi.fn(),
      };
      await expect(
        terminal!.handle?.(
          JSON.stringify({ threadId: "ses_test", cols: 100, rows: 30 }),
          io as never,
        ),
      ).resolves.toBe(JSON.stringify({ exitCode: 0 }));
      expect(nodeHostMocks.runNodePtyCommand).toHaveBeenCalledWith(
        {
          file: expect.stringMatching(/opencode$/u),
          args: ["--session", "ses_test"],
          cwd: "/workspace",
          cols: 100,
          rows: 30,
        },
        io,
      );
      await expect(
        terminal!.handle?.(
          JSON.stringify({ threadId: "--help", cols: 100, rows: 30 }),
          io as never,
        ),
      ).rejects.toThrow("threadId is invalid");

      const invokeNode = vi.fn(() => ({ ok: false as const, error: "unexpected" }));
      const policy = policies[0]!;
      expect(
        policy.handle({ command: OPENCODE_TERMINAL_RESUME_COMMAND, invokeNode } as never),
      ).toEqual({ ok: true });
      expect(
        policy.handle({ command: OPENCODE_SESSIONS_LIST_COMMAND, invokeNode } as never),
      ).toEqual({ ok: false, error: "unexpected" });
    },
  );

  it("marks paired-node sessions terminal-capable only when the resume command is advertised", async () => {
    let provider: Parameters<OpenClawPluginApi["registerSessionCatalog"]>[0] | undefined;
    const page = {
      payloadJSON: JSON.stringify({
        sessions: [
          {
            threadId: "ses_remote",
            cwd: "/remote/workspace",
            status: "stored",
            archived: false,
            canContinue: false,
            canArchive: false,
          },
        ],
      }),
    };
    const invoke = vi.fn().mockResolvedValue(page);
    registerOpenCodeSessionCatalog({
      pluginConfig: {},
      runtime: {
        nodes: {
          list: vi.fn().mockResolvedValue({
            nodes: [
              {
                nodeId: "node-1",
                connected: true,
                commands: [OPENCODE_SESSIONS_LIST_COMMAND, OPENCODE_TERMINAL_RESUME_COMMAND],
              },
            ],
          }),
          invoke,
        },
      },
      registerSessionCatalog: (value: NonNullable<typeof provider>) => {
        provider = value;
      },
      registerNodeHostCommand: vi.fn(),
      registerNodeInvokePolicy: vi.fn(),
    } as unknown as OpenClawPluginApi);

    await expect(provider!.list({ hostIds: ["node:node-1"], search: "remote" })).resolves.toEqual([
      expect.objectContaining({
        sessions: [expect.objectContaining({ threadId: "ses_remote", canOpenTerminal: true })],
      }),
    ]);
    expect(invoke).toHaveBeenNthCalledWith(1, {
      nodeId: "node-1",
      command: OPENCODE_SESSIONS_LIST_COMMAND,
      params: { searchTerm: "remote" },
      timeoutMs: 35_000,
      scopes: ["operator.write"],
    });
    await expect(
      provider!.openTerminal!({ hostId: "node:node-1", threadId: "ses_remote" }),
    ).resolves.toEqual({
      kind: "node",
      nodeId: "node-1",
      command: OPENCODE_TERMINAL_RESUME_COMMAND,
      paramsJSON: JSON.stringify({ threadId: "ses_remote" }),
      cwd: "/remote/workspace",
      title: "opencode --session ses_remote…",
    });
    expect(invoke).toHaveBeenLastCalledWith({
      nodeId: "node-1",
      command: OPENCODE_SESSIONS_LIST_COMMAND,
      params: { searchTerm: "ses_remote", limit: 100 },
      timeoutMs: 35_000,
      scopes: ["operator.write"],
    });
  });

  it("does not register the catalog when explicitly disabled", () => {
    const registrations = captureOpenCodeSessionRegistrations({
      sessionCatalog: { enabled: false },
    });
    expect(registrations).toEqual({ catalogs: [], commands: [], policies: [] });
  });

  it("bridges paired-node list and read requests without undefined transport fields", async () => {
    let provider: Parameters<OpenClawPluginApi["registerSessionCatalog"]>[0] | undefined;
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        payloadJSON: JSON.stringify({
          sessions: [
            {
              threadId: "ses_remote",
              status: "stored",
              source: "opencode-cli",
              archived: false,
              canContinue: false,
              canArchive: false,
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        payloadJSON: JSON.stringify({
          threadId: "ses_remote",
          items: [{ type: "agentMessage", text: "remote answer" }],
        }),
      });
    const api = {
      pluginConfig: {},
      runtime: {
        nodes: {
          list: vi.fn().mockResolvedValue({
            nodes: [
              {
                nodeId: "node-1",
                displayName: "Remote",
                connected: true,
                commands: [OPENCODE_SESSIONS_LIST_COMMAND, OPENCODE_SESSION_READ_COMMAND],
              },
            ],
          }),
          invoke,
        },
      },
      registerSessionCatalog: (value: NonNullable<typeof provider>) => {
        provider = value;
      },
      registerNodeHostCommand: vi.fn(),
      registerNodeInvokePolicy: vi.fn(),
    } as unknown as OpenClawPluginApi;

    registerOpenCodeSessionCatalog(api);
    const catalog = provider;
    expect(catalog).toBeDefined();
    await catalog!.list({ hostIds: ["node:node-1"] });
    await catalog!.read({ hostId: "node:node-1", threadId: "ses_remote" });

    expect(invoke).toHaveBeenNthCalledWith(1, {
      nodeId: "node-1",
      command: OPENCODE_SESSIONS_LIST_COMMAND,
      params: {},
      timeoutMs: 35_000,
      scopes: ["operator.write"],
    });
    expect(invoke).toHaveBeenNthCalledWith(2, {
      nodeId: "node-1",
      command: OPENCODE_SESSION_READ_COMMAND,
      params: { threadId: "ses_remote" },
      timeoutMs: 35_000,
      scopes: ["operator.write"],
    });

    invoke.mockResolvedValueOnce({
      payloadJSON: JSON.stringify({
        sessions: [
          {
            threadId: 123,
            status: "stored",
            archived: false,
            canContinue: false,
            canArchive: false,
          },
        ],
      }),
    });
    await expect(catalog!.list({ hostIds: ["node:node-1"] })).resolves.toEqual([
      expect.objectContaining({
        error: { code: "NODE_INVOKE_FAILED", message: expect.any(String) },
      }),
    ]);

    invoke.mockResolvedValueOnce({
      payloadJSON: JSON.stringify({
        sessions: [
          {
            threadId: "--help",
            status: "stored",
            archived: false,
            canContinue: false,
            canArchive: false,
          },
        ],
      }),
    });
    await expect(catalog!.list({ hostIds: ["node:node-1"] })).resolves.toEqual([
      expect.objectContaining({
        error: { code: "NODE_INVOKE_FAILED", message: expect.any(String) },
      }),
    ]);

    invoke.mockResolvedValueOnce({
      payloadJSON: JSON.stringify({
        threadId: "ses_remote",
        items: [{ type: "invalid", text: "bad" }],
      }),
    });
    await expect(catalog!.read({ hostId: "node:node-1", threadId: "ses_remote" })).rejects.toThrow(
      "invalid transcript page",
    );
  });

  it.each(["stdout", "stderr"] as const)(
    "rejects and reaps the real OpenCode child when its %s pipe fails",
    async (streamName) => {
      await installHangingOpenCode();
      const uncaughtException = vi.fn();
      process.on("uncaughtExceptionMonitor", uncaughtException);
      let child: ChildProcess | undefined;
      try {
        const listing = listLocalOpenCodeSessionPage({ limit: 20 });
        await vi.waitFor(() => expect(childProcessMocks.spawn).toHaveBeenCalledTimes(1));
        child = childProcessMocks.children[0];
        expect(child?.pid).toBeTypeOf("number");
        await once(child!.stdout!, "data");

        child![streamName]!.destroy(new Error(`${streamName} EPIPE`));

        await expect(listing).rejects.toThrow(
          `OpenCode ${streamName} stream failed: ${streamName} EPIPE`,
        );
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(uncaughtException).not.toHaveBeenCalled();
        expect(isProcessRunning(child!.pid)).toBe(false);
      } finally {
        process.off("uncaughtExceptionMonitor", uncaughtException);
        await stopChild(child);
      }
    },
  );

  it("fans out paired-node listing instead of blocking later hosts", async () => {
    let provider: Parameters<OpenClawPluginApi["registerSessionCatalog"]>[0] | undefined;
    let releaseSlow: ((value: unknown) => void) | undefined;
    const slow = new Promise<unknown>((resolve) => {
      releaseSlow = resolve;
    });
    const page = (threadId: string) => ({
      payloadJSON: JSON.stringify({
        sessions: [
          {
            threadId,
            status: "stored",
            archived: false,
            canContinue: false,
            canArchive: false,
          },
        ],
      }),
    });
    const invoke = vi.fn(({ nodeId }: { nodeId: string }) =>
      nodeId === "node-a" ? slow : Promise.resolve(page("session-b")),
    );
    const api = {
      pluginConfig: {},
      runtime: {
        nodes: {
          list: vi.fn().mockResolvedValue({
            nodes: ["node-a", "node-b"].map((nodeId) => ({
              nodeId,
              connected: true,
              commands: [OPENCODE_SESSIONS_LIST_COMMAND],
            })),
          }),
          invoke,
        },
      },
      registerSessionCatalog: (value: NonNullable<typeof provider>) => {
        provider = value;
      },
      registerNodeHostCommand: vi.fn(),
      registerNodeInvokePolicy: vi.fn(),
    } as unknown as OpenClawPluginApi;
    registerOpenCodeSessionCatalog(api);

    const listing = provider!.list({ hostIds: ["node:node-a", "node:node-b"] });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    releaseSlow?.(page("session-a"));
    await expect(listing).resolves.toEqual([
      expect.objectContaining({ nodeId: "node-a", sessions: [expect.any(Object)] }),
      expect.objectContaining({ nodeId: "node-b", sessions: [expect.any(Object)] }),
    ]);
  });
});
