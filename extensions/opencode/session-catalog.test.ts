import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";

const nodeHostMocks = vi.hoisted(() => ({
  runNodePtyCommand: vi.fn(async () => ({ exitCode: 0 })),
}));

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

import {
  createOpenCodeSessionNodeInvokePolicies,
  createOpenCodeSessionNodeHostCommands,
  isOpenCodeSessionCatalogEnabled,
  OPENCODE_SESSIONS_LIST_COMMAND,
  OPENCODE_SESSION_READ_COMMAND,
  OPENCODE_TERMINAL_RESUME_COMMAND,
  registerOpenCodeSessionCatalog,
} from "./session-catalog-plugin.js";
import {
  listLocalOpenCodeSessionPage,
  readLocalOpenCodeTranscriptPage,
} from "./session-catalog.js";

const temporaryDirectories: string[] = [];
const originalPath = process.env.PATH;
const originalUnrelatedEnv = process.env.CATALOG_UNRELATED_ENV;

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

afterEach(async () => {
  nodeHostMocks.runNodePtyCommand.mockClear();
  process.env.PATH = originalPath;
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
      const commands = createOpenCodeSessionNodeHostCommands();
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
      const terminal = createOpenCodeSessionNodeHostCommands().find(
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
      const policy = createOpenCodeSessionNodeInvokePolicies()[0]!;
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
    const registerSessionCatalog = vi.fn();
    const api = {
      pluginConfig: { sessionCatalog: { enabled: false } },
      registerSessionCatalog,
    } as unknown as OpenClawPluginApi;
    registerOpenCodeSessionCatalog(api);
    expect(isOpenCodeSessionCatalogEnabled(api.pluginConfig)).toBe(false);
    expect(registerSessionCatalog).not.toHaveBeenCalled();
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
