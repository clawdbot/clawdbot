import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import type { SessionTranscriptWriteLockContext } from "openclaw/plugin-sdk/session-transcript-runtime";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";

type ResolveAcpSessionAvailability =
  (typeof import("openclaw/plugin-sdk/acp-runtime"))["resolveAcpSessionAvailability"];
type RunCommandBuffered =
  (typeof import("openclaw/plugin-sdk/process-runtime"))["runCommandBuffered"];
type RegisteredSessionCatalogProvider = Parameters<OpenClawPluginApi["registerSessionCatalog"]>[0];
type OptionalCatalogAgent<T extends { agentId?: string }> = Omit<T, "agentId"> & {
  agentId?: string;
};
type SessionCatalogProvider = Omit<
  RegisteredSessionCatalogProvider,
  "list" | "read" | "continueSession" | "archive" | "openTerminal"
> & {
  list: (
    params: OptionalCatalogAgent<Parameters<RegisteredSessionCatalogProvider["list"]>[0]>,
  ) => ReturnType<RegisteredSessionCatalogProvider["list"]>;
  read: (
    params: OptionalCatalogAgent<Parameters<RegisteredSessionCatalogProvider["read"]>[0]>,
  ) => ReturnType<RegisteredSessionCatalogProvider["read"]>;
  continueSession?: (
    params: OptionalCatalogAgent<
      Parameters<NonNullable<RegisteredSessionCatalogProvider["continueSession"]>>[0]
    >,
  ) => ReturnType<NonNullable<RegisteredSessionCatalogProvider["continueSession"]>>;
  archive?: (
    params: OptionalCatalogAgent<
      Parameters<NonNullable<RegisteredSessionCatalogProvider["archive"]>>[0]
    >,
  ) => ReturnType<NonNullable<RegisteredSessionCatalogProvider["archive"]>>;
  openTerminal?: (
    params: OptionalCatalogAgent<
      Parameters<NonNullable<RegisteredSessionCatalogProvider["openTerminal"]>>[0]
    >,
  ) => ReturnType<NonNullable<RegisteredSessionCatalogProvider["openTerminal"]>>;
};
type NodeHostCommand = Parameters<OpenClawPluginApi["registerNodeHostCommand"]>[0];
type NodeInvokePolicy = Parameters<OpenClawPluginApi["registerNodeInvokePolicy"]>[0];
type CatalogListParams = Parameters<SessionCatalogProvider["list"]>[0];
type CatalogReadParams = Parameters<SessionCatalogProvider["read"]>[0];
type CreateSessionEntryParams = Parameters<
  OpenClawPluginApi["runtime"]["agent"]["session"]["createSessionEntry"]
>[0];

function bindTestCatalogOwner(provider: RegisteredSessionCatalogProvider): SessionCatalogProvider {
  return {
    ...provider,
    list: (params) => provider.list({ agentId: "main", ...params }),
    read: (params) => provider.read({ agentId: "main", ...params }),
    ...(provider.continueSession
      ? {
          continueSession: (params) => provider.continueSession!({ agentId: "main", ...params }),
        }
      : {}),
    ...(provider.archive
      ? { archive: (params) => provider.archive!({ agentId: "main", ...params }) }
      : {}),
    ...(provider.openTerminal
      ? {
          openTerminal: (params) => provider.openTerminal!({ agentId: "main", ...params }),
        }
      : {}),
  } as SessionCatalogProvider;
}

const nodeHostMocks = vi.hoisted(() => ({
  runNodePtyCommand: vi.fn(async () => ({ exitCode: 0 })),
}));
const acpRuntimeMocks = vi.hoisted(() => ({
  resolveAcpSessionAvailability: vi.fn<ResolveAcpSessionAvailability>(() => ({ available: true })),
}));
const processRuntimeMocks = vi.hoisted(() => ({
  runCommandBuffered: vi.fn<RunCommandBuffered>(),
}));
const transcriptMocks = vi.hoisted(() => ({
  messages: [] as Array<Record<string, unknown>>,
}));

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>();
  processRuntimeMocks.runCommandBuffered.mockImplementation(actual.runCommandBuffered);
  return { ...actual, runCommandBuffered: processRuntimeMocks.runCommandBuffered };
});

vi.mock("openclaw/plugin-sdk/acp-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/acp-runtime")>()),
  resolveAcpSessionAvailability: acpRuntimeMocks.resolveAcpSessionAvailability,
}));

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-runtime")>();
  return {
    ...actual,
    withSessionTranscriptWriteLock: async (
      _params: unknown,
      run: (context: Pick<SessionTranscriptWriteLockContext, "appendMessage">) => Promise<void>,
    ) => {
      await run({
        appendMessage: async ({ message, idempotencyLookup }) => {
          const record = message as Record<string, unknown>;
          const key = record.idempotencyKey;
          if (
            idempotencyLookup === "scan" &&
            typeof key === "string" &&
            transcriptMocks.messages.some((candidate) => candidate.idempotencyKey === key)
          ) {
            return;
          }
          transcriptMocks.messages.push(record);
        },
      });
    },
  };
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
const pairedNodeLocator = { hostId: "node:node-1", threadId: "ses_remote" } as const;
const removeDirectory = (directory: string) => fs.rm(directory, { recursive: true, force: true });

function captureOpenCodeSessionRegistrations(
  pluginConfig: OpenClawPluginApi["pluginConfig"] = {},
  overrides: Record<string, unknown> = {},
) {
  const catalogs: SessionCatalogProvider[] = [];
  const commands: NodeHostCommand[] = [];
  const policies: NodeInvokePolicy[] = [];
  registerOpenCodeSessionCatalog(
    createTestPluginApi({
      id: "opencode",
      pluginConfig,
      runtime: {
        nodes: { list: vi.fn().mockResolvedValue({ nodes: [] }) },
      } as unknown as OpenClawPluginApi["runtime"],
      ...(overrides as Partial<OpenClawPluginApi>),
      registerSessionCatalog: (catalog: RegisteredSessionCatalogProvider) =>
        catalogs.push(bindTestCatalogOwner(catalog)),
      registerNodeHostCommand: (command: NodeHostCommand) => commands.push(command),
      registerNodeInvokePolicy: (policy: NodeInvokePolicy) => policies.push(policy),
    }),
  );
  return { catalogs, commands, policies, provider: catalogs[0] };
}

function pairedNodeSession(overrides: Record<string, unknown> = {}) {
  return {
    threadId: "ses_remote",
    status: "stored",
    archived: false,
    canContinue: false,
    canArchive: false,
    ...overrides,
  };
}

const nodePayload = (payload: unknown) => ({ payloadJSON: JSON.stringify(payload) });

function pairedNodeSessionPage(...sessions: Array<Record<string, unknown>>) {
  return nodePayload({ sessions });
}

const pairedNode = (commands: string[], overrides: Record<string, unknown> = {}) => ({
  nodeId: "node-1",
  connected: true,
  commands,
  ...overrides,
});

function capturePairedNodeCatalog(nodes: Array<Record<string, unknown>>, invoke: unknown) {
  const listNodes = vi.fn().mockResolvedValue({ nodes });
  const { provider } = captureOpenCodeSessionRegistrations(
    {},
    {
      runtime: { nodes: { list: listNodes, invoke } },
    },
  );
  return { listNodes, provider };
}

const listPairedNode = (
  provider: SessionCatalogProvider,
  params: Omit<CatalogListParams, "hostIds"> = {},
) => provider.list({ hostIds: [pairedNodeLocator.hostId], ...params });

const readPairedNode = (
  provider: SessionCatalogProvider,
  params: Omit<CatalogReadParams, "hostId" | "threadId"> = {},
) => provider.read({ ...pairedNodeLocator, ...params });

const readTestTranscript = (
  params: Omit<Parameters<typeof readLocalOpenCodeTranscriptPage>[0], "threadId"> = {},
) => readLocalOpenCodeTranscriptPage({ threadId: "ses_test", ...params });

async function expectRejects(promise: Promise<unknown>, message: string) {
  await expect(promise).rejects.toThrow(message);
}

const nodeInvokeRequest = (command: string, params: Record<string, unknown>) => ({
  nodeId: "node-1",
  command,
  params,
  timeoutMs: 35_000,
  scopes: ["operator.write"],
});

async function expectPairedNodeListError(
  provider: SessionCatalogProvider,
  params: Omit<CatalogListParams, "hostIds"> = {},
) {
  await expect(listPairedNode(provider, params)).resolves.toEqual([
    expect.objectContaining({
      error: { code: "NODE_INVOKE_FAILED", message: expect.any(String) },
    }),
  ]);
}

function captureOpenCodeContinuationCatalog() {
  const entries: Array<{ sessionKey: string; entry: Record<string, unknown> }> = [];
  const createSessionEntry = vi.fn(async (params: CreateSessionEntryParams) => {
    const sessionKey = `agent:${params.agentId ?? "main"}:${params.key}`;
    const entry = {
      sessionId: "adopted-opencode-session",
      updatedAt: Date.now(),
      pluginOwnerId: "opencode",
      initializationPending: true as const,
      ...(params.label ? { label: params.label } : {}),
      ...(params.displayName ? { displayName: params.displayName } : {}),
      ...(params.spawnedCwd ? { spawnedCwd: params.spawnedCwd } : {}),
      pluginExtensions: params.initialEntry.pluginExtensions,
    };
    entries.push({ sessionKey, entry });
    const created = {
      key: sessionKey,
      agentId: params.agentId ?? "main",
      sessionId: entry.sessionId,
      entry,
    };
    try {
      const finalPatch = await params.afterCreate?.(created);
      entry.pluginExtensions = finalPatch?.pluginExtensions ?? entry.pluginExtensions;
      delete (entry as { initializationPending?: true }).initializationPending;
      return created;
    } catch (error) {
      entries.splice(
        entries.findIndex((candidate) => candidate.entry === entry),
        1,
      );
      throw error;
    }
  });
  const session = { createSessionEntry, listSessionEntries: vi.fn(() => entries) };
  const runtime = {
    config: { current: () => ({}) },
    nodes: { list: vi.fn().mockResolvedValue({ nodes: [] }) },
    agent: { session },
  };
  const { provider } = captureOpenCodeSessionRegistrations(
    {},
    { id: "opencode", config: {}, runtime },
  );
  return { createSessionEntry, entries, provider: provider! };
}

async function installFakeOpenCode(
  assistantText = "hi",
  sessionTitle = "Catalog session",
  toolInput: unknown = { command: "pwd" },
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
  const model = { providerID: "anthropic", modelID: "claude" };
  const exported = {
    info: session,
    messages: [
      {
        info: { id: "msg_user", role: "user", time: { created: session.created }, model },
        parts: [{ id: "prt_user", type: "text", text: "hello" }],
      },
      {
        info: {
          id: "msg_assistant",
          role: "assistant",
          time: { created: session.updated },
          ...model,
        },
        parts: [
          { id: "prt_reason", type: "reasoning", text: "thinking" },
          { id: "prt_answer", type: "text", text: assistantText },
          {
            id: "prt_tool",
            type: "tool",
            tool: "bash",
            state: { status: "completed", input: toolInput, output: "/workspace" },
          },
        ],
      },
    ],
  };
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (process.env.CATALOG_UNRELATED_ENV) process.exit(3);
if (args[0] === "--pure" && args[1] === "db" && args.includes("--format") && args.includes("json")) {
  process.stdout.write(args[2].includes("event_sequence")
    ? ${JSON.stringify(JSON.stringify([{ id: "ses_test", seq: 4 }]))}
    : ${JSON.stringify(JSON.stringify([session]))});
} else if (args[0] === "--pure" && args[1] === "export" && args[2] === "ses_test") {
  process.stdout.write(${JSON.stringify(JSON.stringify(exported))});
} else {
  process.exitCode = 2;
}
`;
  // Flush and close the executable before exec: a still-open write handle makes
  // the immediately following spawn fail with ETXTBSY under parallel CI shards.
  const executableHandle = await fs.open(executable, "w");
  try {
    await executableHandle.writeFile(script);
    await executableHandle.sync();
  } finally {
    await executableHandle.close();
  }
  if (process.platform === "win32") {
    await fs.writeFile(path.join(directory, "opencode.js"), script);
    // This exact direct-forwarder shape is parsed into a Node entrypoint;
    // the batch wrapper itself is never executed through cmd.exe.
    await fs.writeFile(
      path.join(directory, "opencode.cmd"),
      '@echo off\r\n"%~dp0\\opencode.js" %*\r\n',
    );
  } else {
    await fs.chmod(executable, 0o755);
  }
  process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ""}`;
  process.env.CATALOG_UNRELATED_ENV = "present";
  return directory;
}

function restoreEnv(name: string, value: string | undefined) {
  Reflect.deleteProperty(process.env, name);
  if (value !== undefined) {
    process.env[name] = value;
  }
}

afterEach(async () => {
  acpRuntimeMocks.resolveAcpSessionAvailability.mockReset().mockReturnValue({ available: true });
  nodeHostMocks.runNodePtyCommand.mockClear();
  processRuntimeMocks.runCommandBuffered.mockClear();
  transcriptMocks.messages.length = 0;
  process.env.PATH = originalPath;
  restoreEnv("PATHEXT", originalPathExt);
  restoreEnv("CATALOG_UNRELATED_ENV", originalUnrelatedEnv);
  await Promise.all(temporaryDirectories.splice(0).map(removeDirectory));
});

const itWithCli = it.runIf(process.platform !== "win32");

describe("OpenCode session catalog", () => {
  itWithCli("lists and reads sessions through the official CLI JSON surfaces", async () => {
    await installFakeOpenCode();
    const listed = await listLocalOpenCodeSessionPage({ limit: 20 });
    const expectedSession = {
      threadId: "ses_test",
      name: "Catalog session",
      cwd: "/workspace",
      source: "opencode-cli",
      canContinue: true,
    };
    expect(listed).toEqual({ sessions: [expect.objectContaining(expectedSession)] });

    const transcript = await readTestTranscript({ limit: 20 });
    expect(transcript.items.map((item) => [item.type, item.text])).toEqual([
      ["toolResult", "/workspace"],
      ["toolCall", 'bash\n{"command":"pwd"}'],
      ["agentMessage", "hi"],
      ["reasoning", "thinking"],
      ["userMessage", "hello"],
    ]);
    const itemIds = transcript.items.flatMap((item) => (item.id ? [item.id] : []));
    expect(new Set(itemIds).size).toBe(itemIds.length);

    const latest = await readTestTranscript({ limit: 2 });
    expect(latest.items.map((item) => item.type)).toEqual(["toolResult", "toolCall"]);
    expect(latest.nextCursor).toBeTruthy();
    const older = await readTestTranscript({ limit: 2, cursor: latest.nextCursor });
    expect(older.items.map((item) => item.type)).toEqual(["agentMessage", "reasoning"]);
    const nonEmitted = Buffer.from(JSON.stringify({ offset: 2, extra: true }), "utf8").toString(
      "base64url",
    );
    const unsafeOffset = Buffer.from(
      JSON.stringify({ offset: Number.MAX_SAFE_INTEGER + 1 }),
      "utf8",
    ).toString("base64url");
    for (const cursor of [
      `${latest.nextCursor}$`,
      `${latest.nextCursor}=`,
      ` ${latest.nextCursor} `,
      nonEmitted,
      unsafeOffset,
    ]) {
      await expectRejects(readTestTranscript({ cursor }), "cursor is invalid");
    }
    await expectRejects(listLocalOpenCodeSessionPage({ cursor: " " }), "cursor is invalid");
    await expectRejects(readTestTranscript({ cursor: 123 }), "cursor is invalid");
    await expectRejects(
      readLocalOpenCodeTranscriptPage({ threadId: "--help" }),
      "threadId is invalid",
    );

    const { provider } = captureOpenCodeSessionRegistrations();
    await expect(
      provider!.read({ hostId: "gateway", threadId: "ses_test", limit: 2 }),
    ).resolves.toMatchObject({ threadId: "ses_test", items: expect.any(Array) });
    await expect(provider!.list({})).resolves.toEqual([
      expect.objectContaining({ hostId: "gateway", sessions: [expect.any(Object)] }),
    ]);
  });

  itWithCli("allows a relative OPENCODE_DB as an explicit isolated-state root", async () => {
    await installFakeOpenCode();
    const { provider } = captureOpenCodeSessionRegistrations();

    await withEnvAsync(
      { OPENCODE_DB: undefined, XDG_DATA_HOME: undefined },
      async () =>
        await Promise.all([
          expect(
            provider!.list({ allowProcessHomeFallback: false, hostIds: ["gateway"] }),
          ).resolves.toEqual([]),
          expect(
            provider!.continueSession?.({
              allowProcessHomeFallback: false,
              hostId: "gateway",
              threadId: "ses_test",
            }),
          ).rejects.toThrow("local OpenCode sessions are unavailable in isolated state"),
          expect(
            provider!.openTerminal?.({
              allowProcessHomeFallback: false,
              hostId: "gateway",
              threadId: "ses_test",
            }),
          ).rejects.toThrow("local OpenCode sessions are unavailable in isolated state"),
        ]),
    );
    await withEnvAsync({ OPENCODE_DB: "relative.db", XDG_DATA_HOME: undefined }, async () => {
      await expect(
        provider!.list({ allowProcessHomeFallback: false, hostIds: ["gateway"] }),
      ).resolves.toEqual([expect.objectContaining({ hostId: "gateway" })]);
      await expect(
        provider!.read({
          allowProcessHomeFallback: false,
          hostId: "gateway",
          threadId: "ses_test",
        }),
      ).resolves.toMatchObject({ hostId: "gateway", threadId: "ses_test" });
    });
  });

  itWithCli(
    "memoizes the CLI database query across cadence and invalidates by config identity",
    async () => {
      await installFakeOpenCode();
      let now = 1_000;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
      const configIdentity = {};
      try {
        await listLocalOpenCodeSessionPage({ limit: 20 }, { configIdentity });
        await listLocalOpenCodeSessionPage({ limit: 20 }, { configIdentity });
        expect(processRuntimeMocks.runCommandBuffered).toHaveBeenCalledOnce();

        now += 31_999;
        await listLocalOpenCodeSessionPage({ limit: 20 }, { configIdentity });
        expect(processRuntimeMocks.runCommandBuffered).toHaveBeenCalledOnce();

        await listLocalOpenCodeSessionPage({ limit: 20 }, { configIdentity, forceRefresh: true });
        expect(processRuntimeMocks.runCommandBuffered).toHaveBeenCalledTimes(2);

        await listLocalOpenCodeSessionPage({ limit: 20 }, { configIdentity: {} });
        expect(processRuntimeMocks.runCommandBuffered).toHaveBeenCalledTimes(3);

        now += 32_001;
        await listLocalOpenCodeSessionPage({ limit: 20 }, { configIdentity });
        expect(processRuntimeMocks.runCommandBuffered).toHaveBeenCalledTimes(4);
      } finally {
        nowSpy.mockRestore();
      }
    },
  );

  itWithCli("hides and rejects Continue when ACP cannot resume OpenCode", async () => {
    await installFakeOpenCode();
    acpRuntimeMocks.resolveAcpSessionAvailability.mockReturnValue({
      available: false,
      message: "ACP runtime backend is unavailable",
    });
    const { provider } = captureOpenCodeContinuationCatalog();

    await expect(provider.list({ hostIds: ["gateway"] })).resolves.toEqual([
      expect.objectContaining({
        sessions: [expect.objectContaining({ threadId: "ses_test", canContinue: false })],
      }),
    ]);
    await expectRejects(
      provider.continueSession!({ hostId: "gateway", threadId: "ses_test" }),
      "ACP runtime backend is unavailable",
    );
  });

  itWithCli("keeps oversized transcript items below the node payload budget", async () => {
    await installFakeOpenCode("x".repeat(600 * 1024));
    const transcript = await readTestTranscript({ limit: 20 });
    const answer = transcript.items.find((item) => item.type === "agentMessage");
    expect(answer?.text?.endsWith("…")).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(transcript), "utf8")).toBeLessThan(20 * 1024 * 1024);
  });

  itWithCli("adopts local OpenCode sessions once with the native ACP resume binding", async () => {
    await installFakeOpenCode();
    const { createSessionEntry, provider } = captureOpenCodeContinuationCatalog();

    const [first, concurrent] = await Promise.all([
      provider.continueSession!({ hostId: "gateway", threadId: "ses_test" }),
      provider.continueSession!({ hostId: "gateway", threadId: "ses_test" }),
    ]);
    const second = await provider.continueSession!({
      hostId: "gateway",
      threadId: "ses_test",
    });

    expect(first).toEqual(concurrent);
    expect(second).toEqual(first);
    expect(first.upstream).toEqual({
      kind: "opencode-cli",
      ref: { threadId: "ses_test" },
      marker: {
        seq: 4,
        lastHumanMessageId: "msg_user",
      },
    });
    expect(createSessionEntry).toHaveBeenCalledTimes(1);
    expect(createSessionEntry.mock.calls[0]?.[0]).not.toHaveProperty("label");
    expect(createSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "Catalog session",
        spawnedCwd: "/workspace",
        initialEntry: {
          acpBackendId: "acpx",
          acpSessionBinding: { acpAgentId: "opencode", agentSessionId: "ses_test" },
          pluginExtensions: {
            opencode: { sessionCatalog: { sourceThreadId: "ses_test" } },
          },
        },
      }),
    );
    expect(
      transcriptMocks.messages.map((message) =>
        typeof message.content === "string"
          ? message.content
          : (message.content as Array<{ text: string }>)[0]?.text,
      ),
    ).toEqual([
      "hello",
      "Thinking\n\nthinking",
      "hi",
      'Tool call\n\nbash\n{"command":"pwd"}',
      "Tool result\n\n/workspace",
    ]);
    expect(transcriptMocks.messages[0]?.["__openclaw"]).toEqual({
      mirrorOrigin: "opencode-catalog-import",
    });
  });

  itWithCli("projects only adopted OpenCode rows with their OpenClaw session key", async () => {
    await installFakeOpenCode();
    const { entries, provider } = captureOpenCodeContinuationCatalog();
    const sessionEntries = { entriesForAgent: () => entries } as never;

    const before = await provider.list({ hostIds: ["gateway"], sessionEntries });
    expect(before[0]?.sessions[0]).not.toHaveProperty("sessionKey");

    const adopted = await provider.continueSession!({
      hostId: "gateway",
      threadId: "ses_test",
    });
    const after = await provider.list({ hostIds: ["gateway"], sessionEntries });

    expect(after[0]?.sessions[0]).toMatchObject({
      threadId: "ses_test",
      sessionKey: adopted.sessionKey,
    });
  });

  itWithCli("rejects paired-node and unknown OpenCode session continuation", async () => {
    await installFakeOpenCode();
    const { createSessionEntry, provider } = captureOpenCodeContinuationCatalog();

    await expectRejects(
      provider.continueSession!({ hostId: "node:remote", threadId: "ses_test" }),
      "paired-node OpenCode session rows are view-only",
    );
    await expectRejects(
      provider.continueSession!({ hostId: "gateway", threadId: "missing" }),
      "OpenCode session is unavailable",
    );
    expect(createSessionEntry).not.toHaveBeenCalled();
  });

  itWithCli("keeps truncated tool input on a valid UTF-16 boundary", async () => {
    await installFakeOpenCode("hi", "Catalog session", {
      value: `${"x".repeat(19_989)}🎉`,
    });
    const transcript = await readTestTranscript({ limit: 20 });
    const toolCall = transcript.items.find((item) => item.type === "toolCall");

    expect(toolCall?.text).toMatch(/…$/u);
    expect(toolCall?.text).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
  });

  itWithCli("auto-detects the CLI and honors the node-local Web UI switch", async () => {
    const directory = await installFakeOpenCode();
    const { commands } = captureOpenCodeSessionRegistrations();
    const commandsAvailable = (config: unknown, PATH: string) =>
      commands.every((command) => command.isAvailable?.({ config, env: { PATH } } as never));
    expect(commands.map((command) => command.command)).toEqual([
      OPENCODE_SESSIONS_LIST_COMMAND,
      OPENCODE_SESSION_READ_COMMAND,
      OPENCODE_TERMINAL_RESUME_COMMAND,
    ]);
    expect(commandsAvailable({}, directory)).toBe(true);
    expect(
      commandsAvailable(
        {
          plugins: {
            entries: { opencode: { config: { sessionCatalog: { enabled: false } } } },
          },
        },
        directory,
      ),
    ).toBe(false);
    expect(commandsAvailable({}, path.join(directory, "missing"))).toBe(false);
  });

  it("opens validated local sessions with the upstream terminal resume contract", async () => {
    const directory = await installFakeOpenCode();
    const executable = path.join(
      directory,
      process.platform === "win32" ? "opencode.cmd" : "opencode",
    );
    const { provider } = captureOpenCodeSessionRegistrations();

    await expect(provider!.list({ hostIds: ["gateway"] })).resolves.toEqual([
      expect.objectContaining({
        sessions: [expect.objectContaining({ threadId: "ses_test", canOpenTerminal: true })],
      }),
    ]);
    await expect(
      provider!.openTerminal!({ hostId: "gateway", threadId: "ses_test" }),
    ).resolves.toEqual({
      kind: "local",
      argv: [executable, "--session", "ses_test"],
      cwd: "/workspace",
      title: "opencode --session ses_test…",
    });
    await expectRejects(
      provider!.openTerminal!({ hostId: "gateway", threadId: "missing" }),
      "OpenCode session is unavailable",
    );
  });

  it("runs only catalog-validated OpenCode sessions through the node PTY", async () => {
    const directory = await installFakeOpenCode();
    const executable = path.join(
      directory,
      process.platform === "win32" ? "opencode.cmd" : "opencode",
    );
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
        file: executable,
        args: ["--session", "ses_test"],
        cwd: "/workspace",
        cols: 100,
        rows: 30,
      },
      io,
    );
    await expect(
      terminal!.handle?.(JSON.stringify({ threadId: "--help", cols: 100, rows: 30 }), io as never),
    ).rejects.toThrow("threadId is invalid");

    const invokeNode = vi.fn(() => ({ ok: false as const, error: "unexpected" }));
    const policy = policies[0]!;
    expect(
      policy.handle({ command: OPENCODE_TERMINAL_RESUME_COMMAND, invokeNode } as never),
    ).toEqual({ ok: true });
    expect(policy.handle({ command: OPENCODE_SESSIONS_LIST_COMMAND, invokeNode } as never)).toEqual(
      { ok: false, error: "unexpected" },
    );
  });

  it("marks paired-node sessions terminal-capable only when the resume command is advertised", async () => {
    const page = pairedNodeSessionPage({
      ...pairedNodeSession(),
      cwd: "/remote/workspace",
      canContinue: true,
    });
    const invoke = vi.fn().mockResolvedValue(page);
    const nodes = [pairedNode([OPENCODE_SESSIONS_LIST_COMMAND, OPENCODE_TERMINAL_RESUME_COMMAND])];
    const requestListNodes = vi.fn().mockResolvedValue({ nodes });
    const { listNodes: runtimeListNodes, provider } = capturePairedNodeCatalog(nodes, invoke);

    await expect(
      listPairedNode(provider!, { search: "remote", listNodes: requestListNodes }),
    ).resolves.toEqual([
      expect.objectContaining({
        sessions: [
          expect.objectContaining({
            threadId: "ses_remote",
            canContinue: false,
            canOpenTerminal: true,
          }),
        ],
      }),
    ]);
    expect(requestListNodes).toHaveBeenCalledOnce();
    expect(runtimeListNodes).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      nodeInvokeRequest(OPENCODE_SESSIONS_LIST_COMMAND, { searchTerm: "remote" }),
    );
    await expect(provider!.openTerminal!(pairedNodeLocator)).resolves.toEqual({
      kind: "node",
      nodeId: "node-1",
      command: OPENCODE_TERMINAL_RESUME_COMMAND,
      paramsJSON: JSON.stringify({ threadId: "ses_remote" }),
      cwd: "/remote/workspace",
      title: "opencode --session ses_remote…",
    });
    expect(invoke).toHaveBeenLastCalledWith(
      nodeInvokeRequest(OPENCODE_SESSIONS_LIST_COMMAND, {
        searchTerm: "ses_remote",
        limit: 100,
      }),
    );
  });

  it("does not register the catalog when explicitly disabled", () => {
    const { provider: _provider, ...registrations } = captureOpenCodeSessionRegistrations({
      sessionCatalog: { enabled: false },
    });
    expect(registrations).toEqual({ catalogs: [], commands: [], policies: [] });
  });

  it("bridges paired-node list and read requests without undefined transport fields", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(pairedNodeSessionPage(pairedNodeSession({ source: "opencode-cli" })))
      .mockResolvedValueOnce(
        nodePayload({
          threadId: "ses_remote",
          items: [{ type: "agentMessage", text: "remote answer" }],
        }),
      );
    const { provider: catalog } = capturePairedNodeCatalog(
      [
        pairedNode([OPENCODE_SESSIONS_LIST_COMMAND, OPENCODE_SESSION_READ_COMMAND], {
          displayName: "Remote",
        }),
      ],
      invoke,
    );
    expect(catalog).toBeDefined();
    await listPairedNode(catalog!);
    await readPairedNode(catalog!);

    expect(invoke).toHaveBeenNthCalledWith(
      1,
      nodeInvokeRequest(OPENCODE_SESSIONS_LIST_COMMAND, {}),
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      nodeInvokeRequest(OPENCODE_SESSION_READ_COMMAND, { threadId: "ses_remote" }),
    );

    for (const threadId of [123, "--help"]) {
      invoke.mockResolvedValueOnce(pairedNodeSessionPage(pairedNodeSession({ threadId })));
      await expectPairedNodeListError(catalog!);
    }

    invoke.mockResolvedValueOnce(
      nodePayload({
        threadId: "ses_remote",
        items: [{ type: "invalid", text: "bad" }],
      }),
    );
    await expect(readPairedNode(catalog!)).rejects.toThrow("invalid transcript page");

    invoke.mockClear();
    await expect(readPairedNode(catalog!, { cursor: "" })).rejects.toThrow("cursor is invalid");
    await expectPairedNodeListError(catalog!, { cursors: { "node:node-1": "" } });
    expect(invoke).not.toHaveBeenCalled();

    invoke.mockResolvedValueOnce(nodePayload({ sessions: [], nextCursor: " wrapped " }));
    await expectPairedNodeListError(catalog!);
    invoke.mockResolvedValueOnce(
      nodePayload({ threadId: "ses_remote", items: [], nextCursor: " wrapped " }),
    );
    await expect(readPairedNode(catalog!)).rejects.toThrow("invalid cursor");

    const exactCursor = Buffer.from(JSON.stringify({ offset: 1 }), "utf8").toString("base64url");
    invoke.mockResolvedValueOnce(nodePayload({ sessions: [] }));
    await listPairedNode(catalog!, { cursors: { "node:node-1": exactCursor } });
    expect(invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({ params: { cursor: exactCursor } }),
    );
    invoke.mockResolvedValueOnce(nodePayload({ threadId: "ses_remote", items: [] }));
    await readPairedNode(catalog!, { cursor: exactCursor });
    expect(invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({ params: { threadId: "ses_remote", cursor: exactCursor } }),
    );
  });

  it.each(["stdout", "stderr"] as const)(
    "maps a shared-runtime %s pipe failure to the OpenCode-owned error",
    async (streamName) => {
      processRuntimeMocks.runCommandBuffered.mockResolvedValueOnce({
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        code: null,
        signal: null,
        killed: true,
        termination: "error",
        errorStream: streamName,
        error: new Error(`${streamName} EPIPE`),
      });

      await expectRejects(
        listLocalOpenCodeSessionPage({ limit: 20 }),
        `OpenCode ${streamName} stream failed: ${streamName} EPIPE`,
      );
      expect(processRuntimeMocks.runCommandBuffered).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ terminateOnOutputError: true }),
      );
    },
  );

  it("fans out paired-node listing instead of blocking later hosts", async () => {
    let releaseSlow: ((value: unknown) => void) | undefined;
    const slow = new Promise<unknown>((resolve) => {
      releaseSlow = resolve;
    });
    const page = (threadId: string) => pairedNodeSessionPage(pairedNodeSession({ threadId }));
    const invoke = vi.fn(({ nodeId }: { nodeId: string }) =>
      nodeId === "node-a" ? slow : Promise.resolve(page("session-b")),
    );
    const { provider } = capturePairedNodeCatalog(
      ["node-a", "node-b"].map((nodeId) =>
        pairedNode([OPENCODE_SESSIONS_LIST_COMMAND], { nodeId }),
      ),
      invoke,
    );

    const listing = provider!.list({ hostIds: ["node:node-a", "node:node-b"] });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    releaseSlow?.(page("session-a"));
    await expect(listing).resolves.toEqual([
      expect.objectContaining({ nodeId: "node-a", sessions: [expect.any(Object)] }),
      expect.objectContaining({ nodeId: "node-b", sessions: [expect.any(Object)] }),
    ]);
  });
});
