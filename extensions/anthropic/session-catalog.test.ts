import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { SessionCatalogProvider } from "openclaw/plugin-sdk/session-catalog";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adoptedSourceKey } from "./session-catalog-adoption.js";
import {
  createClaudeSessionNodeHostCommands,
  createClaudeSessionNodeInvokePolicies,
} from "./session-catalog-node-commands.js";
import { listBoundClaudeSessions } from "./session-catalog-runtime.js";
import {
  CLAUDE_CLI_NODE_RUN_COMMAND,
  CLAUDE_SESSIONS_LIST_COMMAND,
  CLAUDE_SESSION_READ_COMMAND,
  CLAUDE_TERMINAL_RESUME_COMMAND,
  listLocalClaudeSessionPage,
  readLocalClaudeTranscriptPage,
  registerClaudeSessionCatalog,
} from "./session-catalog.js";

function captureCatalogProvider(runtime: PluginRuntime): SessionCatalogProvider {
  let provider: SessionCatalogProvider | undefined;
  const runtimeWithSession = {
    ...runtime,
    agent: runtime.agent ?? { session: { listSessionEntries: () => [] } },
  } as PluginRuntime;
  registerClaudeSessionCatalog({
    id: "anthropic",
    config: {},
    runtime: runtimeWithSession,
    registerSessionCatalog: (candidate: SessionCatalogProvider) => {
      provider = candidate;
    },
  } as unknown as OpenClawPluginApi);
  if (!provider) {
    throw new Error("expected Anthropic session catalog registration");
  }
  return provider;
}

const homes: string[] = [];
const originalHome = process.env.HOME;
const originalPath = process.env.PATH;
const nodeHostMocks = vi.hoisted(() => ({
  runNodePtyCommand: vi.fn(async () => ({ exitCode: 0 })),
  userShellPaths: new Map<string, string>(),
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
        strategy: "direct" | "fallback" | "prefer";
      },
    ) => {
      const env = options.env ?? process.env;
      const pathEnv = options.pathEnv ?? env.PATH ?? env.Path ?? "";
      const direct = actual.resolveNodeHostExecutable(command, {
        env,
        pathEnv,
        includeExtensionless: options.includeExtensionless,
        strategy: "direct",
      });
      if (direct && options.strategy !== "prefer") {
        return direct;
      }
      const shellPath = nodeHostMocks.userShellPaths.get(command);
      if (!shellPath) {
        return direct;
      }
      const shellExecutable = actual.resolveNodeHostExecutable(command, {
        env,
        pathEnv: shellPath,
        includeExtensionless: options.includeExtensionless,
        strategy: "direct",
      });
      return shellExecutable
        ? { executable: shellExecutable.executable, pathEnv: shellPath }
        : direct;
    },
  };
});

async function createHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-catalog-"));
  homes.push(home);
  return home;
}

async function writeProject(params: {
  home: string;
  project?: string;
  entries: Array<Record<string, unknown>>;
  transcripts: Record<string, Array<Record<string, unknown>>>;
}): Promise<void> {
  const projectDir = path.join(params.home, ".claude", "projects", params.project ?? "-workspace");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, "sessions-index.json"),
    JSON.stringify({ version: 1, entries: params.entries }),
  );
  await Promise.all(
    Object.entries(params.transcripts).map(([sessionId, rows]) =>
      fs.writeFile(
        path.join(projectDir, `${sessionId}.jsonl`),
        `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      ),
    ),
  );
}

async function writeDesktopMetadata(
  home: string,
  name: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const dir = path.join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "claude-code-sessions",
    "account",
    "workspace",
  );
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `local_${name}.json`), JSON.stringify(metadata));
}

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 0x80);
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

function snappyLiteralChunk(value: Buffer): Buffer {
  if (value.length <= 60) {
    return Buffer.concat([Buffer.from([(value.length - 1) << 2]), value]);
  }
  const length = value.length - 1;
  const lengthBytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    lengthBytes.push(remaining & 0xff);
    remaining = Math.floor(remaining / 0x100);
  }
  return Buffer.concat([Buffer.from([(59 + lengthBytes.length) << 2, ...lengthBytes]), value]);
}

const CLAUDE_GROUP_USER_KEY = Buffer.from("_https://claude.ai\0\x01dframe-store", "latin1");

function levelDbInternalKey(sequence: number, kind = 1): Buffer {
  const trailer = Buffer.alloc(8);
  trailer[0] = kind;
  let remaining = sequence;
  for (let index = 1; index < trailer.length; index += 1) {
    trailer[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 0x100);
  }
  return Buffer.concat([CLAUDE_GROUP_USER_KEY, trailer]);
}

function levelDbDataBlock(
  entries: Array<{ sequence: number; value: string | Buffer; kind?: number }>,
): Buffer {
  const encoded: Buffer[] = [];
  let previousKey: Uint8Array = Buffer.alloc(0);
  for (const entry of entries) {
    const key = levelDbInternalKey(entry.sequence, entry.kind ?? 1);
    let shared = 0;
    while (shared < previousKey.length && previousKey[shared] === key[shared]) {
      shared += 1;
    }
    const value = Buffer.from(entry.value);
    encoded.push(
      encodeVarint(shared),
      encodeVarint(key.length - shared),
      encodeVarint(value.length),
      key.subarray(shared),
      value,
    );
    previousKey = key;
  }
  return Buffer.concat([
    ...encoded,
    Buffer.alloc(4), // one restart at the first entry
    Buffer.from([1, 0, 0, 0]),
  ]);
}

function snappyGroupRecords(groupId: string, groupName: string, localSessionId: string): Buffer {
  const group = `{"id":"${groupId}","name":"${groupName}"}`;
  const assignmentPrefix = `{"code:${localSessionId}":"`;
  const key = levelDbInternalKey(1);
  const valueLength =
    Buffer.byteLength(group) + Buffer.byteLength(assignmentPrefix) + groupId.length + 2;
  const firstChunk = Buffer.concat([
    encodeVarint(0),
    encodeVarint(key.length),
    encodeVarint(valueLength),
    key,
    Buffer.from(`${group}${assignmentPrefix}`),
  ]);
  const groupIdOffset = firstChunk.length - firstChunk.indexOf(groupId);
  const tail = Buffer.concat([Buffer.from('"}'), Buffer.alloc(4), Buffer.from([1, 0, 0, 0])]);
  const decodedLength = firstChunk.length + groupId.length + tail.length;
  return Buffer.concat([
    encodeVarint(decodedLength),
    snappyLiteralChunk(firstChunk),
    Buffer.from([((groupId.length - 1) << 2) | 2, groupIdOffset & 0xff, groupIdOffset >> 8]),
    snappyLiteralChunk(tail),
  ]);
}

function levelDbTable(data: Buffer, compression: 0 | 1): Buffer {
  const dataWithTrailer = Buffer.concat([data, Buffer.from([compression, 0, 0, 0, 0])]);
  const handle = Buffer.concat([encodeVarint(0), encodeVarint(data.length)]);
  const indexEntry = Buffer.concat([Buffer.from([0, 1, handle.length, 0x78]), handle]);
  const index = Buffer.concat([
    indexEntry,
    Buffer.alloc(4), // one restart at the start of the index block
    Buffer.from([1, 0, 0, 0]),
  ]);
  const indexWithTrailer = Buffer.concat([index, Buffer.alloc(5)]);
  const footer = Buffer.alloc(48);
  Buffer.concat([
    encodeVarint(0),
    encodeVarint(0),
    encodeVarint(dataWithTrailer.length),
    encodeVarint(index.length),
  ]).copy(footer);
  return Buffer.concat([dataWithTrailer, indexWithTrailer, footer]);
}

async function writeDesktopGroupStore(
  home: string,
  groupId: string,
  groupName: string,
  localSessionId: string,
): Promise<void> {
  const dir = path.join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "Local Storage",
    "leveldb",
  );
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "000001.ldb"),
    levelDbTable(snappyGroupRecords(groupId, groupName, localSessionId), 1),
  );
}

async function writeDesktopGroupStoreEntries(
  home: string,
  entries: Array<{ sequence: number; value: string | Buffer; kind?: number }>,
): Promise<void> {
  const dir = path.join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "Local Storage",
    "leveldb",
  );
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "000001.ldb"), levelDbTable(levelDbDataBlock(entries), 0));
}

async function writeBrokenClaudeNpmShim(binDir: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true });
  const executable = path.join(binDir, process.platform === "win32" ? "claude.cmd" : "claude");
  const packageExecutable = path.join(
    binDir,
    "node_modules",
    "@anthropic-ai",
    "claude-code",
    "bin",
    "claude.exe",
  );
  await fs.mkdir(path.dirname(packageExecutable), { recursive: true });
  await fs.writeFile(
    packageExecutable,
    [
      'echo "Error: claude native binary not installed." >&2',
      'echo "node node_modules/@anthropic-ai/claude-code/install.cjs" >&2',
      "exit 1",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    executable,
    process.platform === "win32"
      ? '@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\n'
      : '#!/bin/sh\nexec "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe" "$@"\n',
  );
  if (process.platform !== "win32") {
    await fs.chmod(executable, 0o755);
    await fs.chmod(packageExecutable, 0o755);
  }
  return executable;
}

function message(
  sessionId: string,
  type: "user" | "assistant",
  text: string,
  index: number,
): Record<string, unknown> {
  return {
    type,
    sessionId,
    uuid: `${sessionId}-${index}`,
    timestamp: `2026-07-0${index}T00:00:00.000Z`,
    isSidechain: false,
    message: {
      role: type,
      content: [{ type: "text", text }],
      ...(type === "assistant" ? { model: "claude-opus-4-8" } : {}),
    },
  };
}

function sdkCliMessage(sessionId: string, text: string): Record<string, unknown> {
  return {
    ...message(sessionId, "user", text, 1),
    entrypoint: "sdk-cli",
    cwd: `/work/${sessionId}`,
    version: "2.1.204",
  };
}

async function writeLongPagedTranscript(params: {
  home: string;
  sessionId: string;
  truncated?: boolean;
}): Promise<string> {
  const oldUser = "old user ".repeat(20_000);
  await writeProject({
    home: params.home,
    entries: [
      {
        sessionId: params.sessionId,
        fullPath: path.join(
          params.home,
          ".claude",
          "projects",
          "-workspace",
          `${params.sessionId}.jsonl`,
        ),
        summary: "Transcript",
        modified: "2026-07-04T00:00:00.000Z",
        isSidechain: false,
      },
    ],
    transcripts: {
      [params.sessionId]: params.truncated
        ? [
            message(params.sessionId, "user", oldUser, 1),
            message(params.sessionId, "assistant", "new assistant", 2),
          ]
        : [
            { type: "queue-operation", sessionId: params.sessionId },
            message(params.sessionId, "user", oldUser, 1),
            message(params.sessionId, "assistant", "old assistant", 2),
            message(params.sessionId, "user", "new user", 3),
            message(params.sessionId, "assistant", "new assistant", 4),
          ],
    },
  });
  return oldUser;
}

// Cap positional reads on one transcript; a zero cap simulates mid-window EOF.
function injectTranscriptShortReads(
  sessionId: string,
  plan: (input: {
    length: number;
    position: number;
    call: number;
    firstPosition: number;
  }) => number,
): void {
  const realOpen = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args);
    const [target] = args;
    if (typeof target === "string" && target.endsWith(`${sessionId}.jsonl`)) {
      const realRead = handle.read.bind(handle) as (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => Promise<{ bytesRead: number; buffer: Buffer }>;
      let call = 0;
      let firstPosition = -1;
      Object.defineProperty(handle, "read", {
        configurable: true,
        value: (buffer: Buffer, offset: number, length: number, position: number) => {
          if (firstPosition < 0) {
            firstPosition = position;
          }
          const allowed = plan({ length, position, call, firstPosition });
          call += 1;
          return realRead(buffer, offset, allowed, position);
        },
      });
    }
    return handle;
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  nodeHostMocks.runNodePtyCommand.mockClear();
  nodeHostMocks.userShellPaths.clear();
  process.env.HOME = originalHome;
  process.env.PATH = originalPath;
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

describe("Claude session catalog", () => {
  it.each([
    {
      label: "catalog marker",
      nodeEntry: {
        pluginOwnerId: "anthropic",
        modelSelectionLocked: true,
        pluginExtensions: {
          anthropic: {
            sessionCatalog: { sourceHostId: "node:node-a", sourceThreadId: "shared-thread" },
          },
        },
      },
    },
    { label: "exec binding", nodeEntry: { execHost: "node", execNode: "node-a" } },
  ])("keeps local and paired-node bindings distinct via $label", ({ nodeEntry }) => {
    const threadId = "shared-thread";
    const api = {
      id: "anthropic",
      config: {},
      runtime: {
        config: { current: () => ({}) },
        agent: {
          session: {
            listSessionEntries: () => [
              {
                sessionKey: "agent:main:local",
                entry: { cliSessionBindings: { "claude-cli": { sessionId: threadId } } },
              },
              {
                sessionKey: "agent:main:node",
                entry: {
                  cliSessionBindings: { "claude-cli": { sessionId: threadId } },
                  ...nodeEntry,
                },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawPluginApi;

    expect(listBoundClaudeSessions(api)).toEqual(
      new Map([
        [adoptedSourceKey("gateway:local", threadId), "agent:main:local"],
        [adoptedSourceKey("node:node-a", threadId), "agent:main:node"],
      ]),
    );
  });

  it("adopts a local CLI row with a locked one-shot fork binding", async () => {
    const home = await createHome();
    process.env.HOME = home;
    const sessionId = "claude-source-session";
    await writeProject({
      home,
      entries: [
        {
          sessionId,
          fullPath: path.join(home, ".claude", "projects", "-workspace", `${sessionId}.jsonl`),
          summary: "Source session",
          projectPath: "/work/source",
        },
      ],
      transcripts: { [sessionId]: [message(sessionId, "user", "source prompt", 1)] },
    });
    const createSessionEntry = vi.fn(async (params: Record<string, unknown>) => ({
      key: `agent:main:${String(params.key)}`,
      agentId: "main",
      sessionId: "openclaw-adopted",
      entry: { sessionId: "openclaw-adopted", updatedAt: Date.now() },
    }));
    let provider: SessionCatalogProvider | undefined;
    const api = {
      id: "anthropic",
      config: {},
      runtime: {
        config: {
          current: () => ({
            agents: {
              defaults: {
                models: {
                  "anthropic/claude-opus-4-8": { agentRuntime: { id: "claude-cli" } },
                },
              },
            },
          }),
        },
        agent: {
          session: {
            listSessionEntries: () => [],
            createSessionEntry,
          },
        },
      },
      registerSessionCatalog: (candidate: SessionCatalogProvider) => {
        provider = candidate;
      },
    } as unknown as OpenClawPluginApi;
    registerClaudeSessionCatalog(api);

    expect(provider?.resolveCreateSession?.({})).toEqual({
      model: "anthropic/claude-opus-4-8",
      agentRuntime: "claude-cli",
    });

    await expect(
      provider?.continueSession?.({ hostId: "gateway:local", threadId: sessionId }),
    ).resolves.toEqual(
      expect.objectContaining({
        sessionKey: expect.stringContaining("plugin:anthropic:catalog-adopt:claude:"),
        upstream: {
          kind: "claude-cli",
          ref: {
            filePath: expect.stringContaining(`${sessionId}.jsonl`),
          },
          marker: { offset: expect.any(Number) },
        },
      }),
    );
    expect(createSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        spawnedCwd: "/work/source",
        initialEntry: expect.objectContaining({
          cliBackendId: "claude-cli",
          model: "claude-opus-4-8",
          modelSelectionLocked: true,
          pluginOwnerId: "anthropic",
          cliSessionBinding: {
            sessionId,
            forceReuse: true,
            forkNextResume: true,
          },
        }),
      }),
    );
  });

  it("does not advertise creation without a configured Claude CLI route", () => {
    let config: OpenClawConfig = {};
    let provider: SessionCatalogProvider | undefined;
    const api = {
      id: "anthropic",
      config: {},
      runtime: {
        config: { current: () => config },
      },
      registerSessionCatalog: (candidate: SessionCatalogProvider) => {
        provider = candidate;
      },
    } as unknown as OpenClawPluginApi;

    registerClaudeSessionCatalog(api);

    expect(provider?.resolveCreateSession?.({})).toBeUndefined();

    config = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-8": { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
    };
    expect(provider?.resolveCreateSession?.({})).toEqual({
      model: "anthropic/claude-opus-4-8",
      agentRuntime: "claude-cli",
    });

    config = {};
    expect(provider?.resolveCreateSession?.({})).toBeUndefined();
  });

  it("resolves creation against the requested agent's runtime policy", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-8": { agentRuntime: { id: "claude-cli" } },
          },
        },
        list: [
          { id: "main", default: true },
          {
            id: "research",
            models: {
              "anthropic/claude-opus-4-8": { agentRuntime: { id: "openclaw" } },
            },
          },
        ],
      },
    } satisfies OpenClawConfig;
    let provider: SessionCatalogProvider | undefined;
    const api = {
      id: "anthropic",
      config,
      runtime: { config: { current: () => config } },
      registerSessionCatalog: (candidate: SessionCatalogProvider) => {
        provider = candidate;
      },
    } as unknown as OpenClawPluginApi;

    registerClaudeSessionCatalog(api);

    expect(provider?.resolveCreateSession?.({ agentId: "main" })).toEqual({
      model: "anthropic/claude-opus-4-8",
      agentRuntime: "claude-cli",
    });
    expect(provider?.resolveCreateSession?.({ agentId: "research" })).toBeUndefined();
  });

  it("does not advertise a Claude CLI route excluded by the model allowlist", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-8" },
          models: { "anthropic/claude-sonnet-4-8": {} },
        },
      },
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com",
            agentRuntime: { id: "claude-cli" },
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;
    let provider: SessionCatalogProvider | undefined;
    const api = {
      id: "anthropic",
      config,
      runtime: { config: { current: () => config } },
      registerSessionCatalog: (candidate: SessionCatalogProvider) => {
        provider = candidate;
      },
    } as unknown as OpenClawPluginApi;

    registerClaudeSessionCatalog(api);

    expect(provider?.resolveCreateSession?.({})).toBeUndefined();
  });

  it.each([
    {
      label: "CLI binding",
      entry: (sessionId: string) => ({
        cliSessionBindings: { "claude-cli": { sessionId } },
      }),
    },
    {
      label: "catalog marker when the CLI binding is empty",
      entry: (sessionId: string) => ({
        cliSessionBindings: { "claude-cli": { sessionId: "" } },
        pluginOwnerId: "anthropic",
        modelSelectionLocked: true,
        pluginExtensions: { anthropic: { sessionCatalog: { sourceThreadId: sessionId } } },
      }),
    },
  ])("links a catalog row to an existing OpenClaw session via $label", async ({ entry }) => {
    const home = await createHome();
    process.env.HOME = home;
    const sessionId = "claude-bound-session";
    await writeProject({
      home,
      entries: [
        {
          sessionId,
          fullPath: path.join(home, ".claude", "projects", "-workspace", `${sessionId}.jsonl`),
          summary: "Bound session",
          projectPath: "/work/source",
        },
      ],
      transcripts: { [sessionId]: [message(sessionId, "user", "source prompt", 1)] },
    });
    let provider: SessionCatalogProvider | undefined;
    const api = {
      id: "anthropic",
      config: {},
      runtime: {
        config: { current: () => ({}) },
        agent: {
          session: {
            listSessionEntries: () => [
              {
                sessionKey: "agent:main:claude-bound",
                entry: entry(sessionId),
              },
            ],
          },
        },
      },
      registerSessionCatalog: (candidate: SessionCatalogProvider) => {
        provider = candidate;
      },
    } as unknown as OpenClawPluginApi;
    registerClaudeSessionCatalog(api);

    const hosts = await provider?.list({});
    expect(hosts?.[0]?.sessions[0]?.sessionKey).toBe("agent:main:claude-bound");
  });

  it("continues a local Desktop-app row and lists it as continuable", async () => {
    const home = await createHome();
    process.env.HOME = home;
    const sessionId = "desktop-source-session";
    await writeProject({
      home,
      entries: [
        {
          sessionId,
          fullPath: path.join(home, ".claude", "projects", "-workspace", `${sessionId}.jsonl`),
          summary: "Index title",
          projectPath: "/work/desktop",
        },
      ],
      transcripts: { [sessionId]: [message(sessionId, "user", "desktop prompt", 1)] },
    });
    await writeDesktopMetadata(home, "active", {
      cliSessionId: sessionId,
      title: "Desktop title",
      cwd: "/desktop/cwd",
      isArchived: false,
    });
    const createSessionEntry = vi.fn(async (params: Record<string, unknown>) => ({
      key: `agent:main:${String(params.key)}`,
      agentId: "main",
      sessionId: "openclaw-adopted",
      entry: { sessionId: "openclaw-adopted", updatedAt: Date.now() },
    }));
    let provider: SessionCatalogProvider | undefined;
    const api = {
      id: "anthropic",
      config: {},
      runtime: {
        config: { current: () => ({}) },
        nodes: { list: async () => ({ nodes: [] }) },
        agent: {
          session: {
            listSessionEntries: () => [],
            createSessionEntry,
          },
        },
      },
      registerSessionCatalog: (candidate: SessionCatalogProvider) => {
        provider = candidate;
      },
    } as unknown as OpenClawPluginApi;
    registerClaudeSessionCatalog(api);

    const hosts = await provider?.list({});
    expect(hosts?.[0]?.sessions).toEqual([
      expect.objectContaining({
        threadId: sessionId,
        source: "claude-desktop",
        canContinue: true,
        canArchive: false,
      }),
    ]);
    await expect(
      provider?.continueSession?.({ hostId: "gateway:local", threadId: sessionId }),
    ).resolves.toEqual(
      expect.objectContaining({
        sessionKey: expect.stringContaining("plugin:anthropic:catalog-adopt:claude:"),
        upstream: expect.objectContaining({ kind: "claude-cli" }),
      }),
    );
    expect(createSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        initialEntry: expect.objectContaining({
          cliSessionBinding: { sessionId, forceReuse: true, forkNextResume: true },
        }),
      }),
    );
  });

  it("continues an advertised paired-node CLI row with node-bound placement", async () => {
    const threadId = "node-claude-session";
    const createSessionEntry = vi.fn(async (params: Record<string, unknown>) => ({
      key: String(params.key),
      agentId: "main",
      sessionId: "adopted-node-session",
      entry: { sessionId: "adopted-node-session", updatedAt: 1 },
    }));
    const commands = [
      CLAUDE_SESSIONS_LIST_COMMAND,
      CLAUDE_SESSION_READ_COMMAND,
      CLAUDE_CLI_NODE_RUN_COMMAND,
      CLAUDE_TERMINAL_RESUME_COMMAND,
    ];
    const authorizedCommands = new Set(
      createClaudeSessionNodeInvokePolicies().flatMap((policy) => policy.commands),
    );
    expect(authorizedCommands).toEqual(new Set(commands));
    const nodes = [
      {
        nodeId: "node-a",
        displayName: "Node A",
        connected: true,
        commands,
        invocableCommands: commands.filter((command) => authorizedCommands.has(command)),
      },
    ];
    const invoke = vi.fn(async ({ command }: Parameters<PluginRuntime["nodes"]["invoke"]>[0]) => {
      if (command === CLAUDE_SESSIONS_LIST_COMMAND) {
        return {
          payloadJSON: JSON.stringify({
            sessions: [
              {
                threadId,
                name: "Node source",
                cwd: "/work/on-node",
                status: "stored",
                source: "claude-cli",
                modelProvider: "anthropic",
                pullRequest: { numbers: [1234], state: "open" },
                archived: false,
              },
            ],
          }),
        };
      }
      return {
        payloadJSON: JSON.stringify({
          threadId,
          items: [{ type: "userMessage", text: "history", uuid: "history-1" }],
        }),
      };
    });
    let provider: SessionCatalogProvider | undefined;
    const api = {
      id: "anthropic",
      config: {},
      runtime: {
        config: { current: () => ({}) },
        nodes: { list: vi.fn(async () => ({ nodes })), invoke },
        agent: {
          session: {
            listSessionEntries: () => [],
            createSessionEntry,
          },
        },
      },
      registerSessionCatalog: (candidate: SessionCatalogProvider) => {
        provider = candidate;
      },
    } as unknown as OpenClawPluginApi;
    registerClaudeSessionCatalog(api);

    const hosts = await provider?.list({ hostIds: ["node:node-a"] });
    expect(hosts?.[0]?.sessions[0]).toMatchObject({
      threadId,
      pullRequest: { numbers: [1234], state: "open" },
      canContinue: true,
      canOpenTerminal: true,
    });
    await expect(
      provider?.openTerminal?.({ hostId: "node:node-a", threadId }),
    ).resolves.toMatchObject({
      kind: "node",
      nodeId: "node-a",
      command: CLAUDE_TERMINAL_RESUME_COMMAND,
      cwd: "/work/on-node",
    });
    await expect(provider?.continueSession?.({ hostId: "node:node-a", threadId })).resolves.toEqual(
      {
        sessionKey: expect.stringContaining("plugin:anthropic:catalog-adopt:claude:"),
        upstream: {
          kind: "claude-cli",
          ref: { nodeId: "node-a", threadId },
          marker: { uuid: "history-1" },
        },
      },
    );
    expect(createSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        execNode: "node-a",
        execCwd: "/work/on-node",
        spawnedCwd: "/work/on-node",
        initialEntry: expect.objectContaining({
          cliSessionBinding: {
            sessionId: threadId,
            forceReuse: true,
            forkNextResume: true,
          },
          pluginExtensions: {
            anthropic: {
              sessionCatalog: { sourceHostId: "node:node-a", sourceThreadId: threadId },
            },
          },
        }),
      }),
    );
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        command: CLAUDE_SESSION_READ_COMMAND,
        scopes: ["operator.write"],
      }),
    );
    expect(invoke.mock.calls.every(([request]) => request.scopes?.includes("operator.write"))).toBe(
      true,
    );

    nodes[0]!.invocableCommands = [
      CLAUDE_SESSIONS_LIST_COMMAND,
      CLAUDE_SESSION_READ_COMMAND,
      CLAUDE_CLI_NODE_RUN_COMMAND,
    ];
    await expect(provider?.list({ hostIds: ["node:node-a"] })).resolves.toMatchObject([
      { sessions: [{ threadId, canOpenTerminal: false }] },
    ]);
    await expect(provider?.openTerminal?.({ hostId: "node:node-a", threadId })).rejects.toThrow(
      "paired-node Claude terminal is unavailable",
    );
  });

  it("keeps policy-blocked, non-advertising, and Desktop rows view-only", async () => {
    const threadId = "view-only-session";
    const commands = [CLAUDE_SESSIONS_LIST_COMMAND, CLAUDE_SESSION_READ_COMMAND];
    const nodes = [
      {
        nodeId: "node-view",
        connected: true,
        commands,
        invocableCommands: [] as string[],
      },
    ];
    const runtime = {
      nodes: {
        list: vi.fn(async () => ({ nodes })),
        invoke: vi.fn(async () => ({
          payloadJSON: JSON.stringify({
            sessions: [
              {
                threadId,
                status: "stored",
                source: "claude-desktop",
                modelProvider: "anthropic",
                archived: false,
              },
            ],
          }),
        })),
      },
      config: { current: () => ({}) },
      agent: {
        session: {
          listSessionEntries: () => [],
          createSessionEntry: vi.fn(),
        },
      },
    } as unknown as PluginRuntime;
    let provider: SessionCatalogProvider | undefined;
    const api = {
      id: "anthropic",
      config: {},
      runtime,
      registerSessionCatalog: (candidate: SessionCatalogProvider) => {
        provider = candidate;
      },
    } as unknown as OpenClawPluginApi;
    registerClaudeSessionCatalog(api);

    const hosts = await provider?.list({ hostIds: ["node:node-view"] });
    expect(hosts?.[0]?.sessions[0]?.canContinue).toBe(false);
    await expect(
      provider?.continueSession?.({ hostId: "node:node-view", threadId }),
    ).rejects.toThrow("does not permit Claude CLI session continuation");

    nodes[0]?.commands.push(CLAUDE_CLI_NODE_RUN_COMMAND);
    const blockedHosts = await provider?.list({ hostIds: ["node:node-view"] });
    expect(blockedHosts?.[0]?.sessions[0]?.canContinue).toBe(false);
    await expect(
      provider?.continueSession?.({ hostId: "node:node-view", threadId }),
    ).rejects.toThrow("does not permit Claude CLI session continuation");

    nodes[0]!.invocableCommands = [CLAUDE_SESSIONS_LIST_COMMAND, CLAUDE_CLI_NODE_RUN_COMMAND];
    const readBlockedHosts = await provider?.list({ hostIds: ["node:node-view"] });
    expect(readBlockedHosts?.[0]?.sessions[0]?.canContinue).toBe(false);
    await expect(
      provider?.continueSession?.({ hostId: "node:node-view", threadId }),
    ).rejects.toThrow("does not permit Claude CLI session continuation");

    nodes[0]!.invocableCommands = [
      CLAUDE_SESSIONS_LIST_COMMAND,
      CLAUDE_SESSION_READ_COMMAND,
      CLAUDE_CLI_NODE_RUN_COMMAND,
    ];
    await expect(
      provider?.continueSession?.({ hostId: "node:node-view", threadId }),
    ).rejects.toThrow("only Claude CLI sessions can be continued");
  });

  it("merges CLI indexes with active Desktop metadata and hides archived Desktop sessions", async () => {
    const home = await createHome();
    await writeProject({
      home,
      entries: [
        {
          sessionId: "cli-session",
          fullPath: path.join(home, ".claude", "projects", "-workspace", "cli-session.jsonl"),
          summary: "CLI title",
          modified: "2026-07-01T00:00:00.000Z",
          projectPath: "/work/cli",
          isSidechain: false,
        },
        {
          sessionId: "desktop-session",
          fullPath: path.join(home, ".claude", "projects", "-workspace", "desktop-session.jsonl"),
          summary: "Index title",
          modified: "2026-07-02T00:00:00.000Z",
          projectPath: "/work/desktop",
          isSidechain: false,
        },
        {
          sessionId: "archived-session",
          fullPath: path.join(home, ".claude", "projects", "-workspace", "archived-session.jsonl"),
          summary: "Archived",
          modified: "2026-07-03T00:00:00.000Z",
          isSidechain: false,
        },
      ],
      transcripts: {
        "cli-session": [message("cli-session", "user", "CLI", 1)],
        "desktop-session": [message("desktop-session", "user", "Desktop", 1)],
        "archived-session": [message("archived-session", "user", "Archived", 1)],
      },
    });
    await writeDesktopMetadata(home, "active", {
      sessionId: "local-active",
      cliSessionId: "desktop-session",
      title: "Desktop title",
      cwd: "/desktop/cwd",
      lastActivityAt: Date.parse("2026-07-04T00:00:00.000Z"),
      isArchived: false,
    });
    await writeDesktopMetadata(home, "archived", {
      sessionId: "local-archived",
      cliSessionId: "archived-session",
      title: "Archived title",
      isArchived: true,
    });

    const first = await listLocalClaudeSessionPage({ limit: 1 }, home);
    expect(first.sessions).toEqual([
      expect.objectContaining({
        threadId: "desktop-session",
        name: "Desktop title",
        cwd: "/desktop/cwd",
        source: "claude-desktop",
        archived: false,
      }),
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));
    await expect(
      listLocalClaudeSessionPage({ limit: 1, cursor: ` ${first.nextCursor} ` }, home),
    ).rejects.toThrow("catalog cursor is invalid");
    const runtime = { nodes: { list: vi.fn() } } as unknown as PluginRuntime;
    const provider = captureCatalogProvider(runtime);
    await expect(
      provider.list({
        hostIds: ["gateway:local"],
        cursors: { "gateway:local": ` ${first.nextCursor} ` },
      }),
    ).rejects.toThrow("cursor for gateway:local is invalid");

    const second = await listLocalClaudeSessionPage({ limit: 1, cursor: first.nextCursor }, home);
    expect(second.sessions).toEqual([
      expect.objectContaining({
        threadId: "cli-session",
        name: "CLI title",
        source: "claude-cli",
      }),
    ]);
    expect(second.nextCursor).toBeUndefined();
    await expect(
      readLocalClaudeTranscriptPage({ threadId: "archived-session", limit: 1 }, home),
    ).rejects.toThrow("Claude session is unavailable");
    await expect(listLocalClaudeSessionPage({ cursor: "x".repeat(257) }, home)).rejects.toThrow(
      "catalog cursor is invalid",
    );
    await expect(listLocalClaudeSessionPage({ cursor: null }, home)).rejects.toThrow(
      "catalog cursor is invalid",
    );
  });

  it("imports a Claude Desktop custom group for its matching catalog row", async () => {
    const home = await createHome();
    const sessionId = "desktop-custom-group";
    const localSessionId = "local_11111111-1111-1111-1111-111111111111";
    await writeProject({
      home,
      entries: [
        {
          sessionId,
          fullPath: path.join(home, ".claude", "projects", "-workspace", `${sessionId}.jsonl`),
          projectPath: "/work/openclaw",
          isSidechain: false,
        },
      ],
      transcripts: { [sessionId]: [message(sessionId, "user", "custom group prompt", 1)] },
    });
    await writeDesktopMetadata(home, "custom-group", {
      sessionId: localSessionId,
      cliSessionId: sessionId,
      cwd: "/work/openclaw",
      title: "Desktop custom group",
    });
    await writeDesktopGroupStore(
      home,
      "cg-22222222-2222-2222-2222-222222222222",
      "Release",
      localSessionId,
    );

    await expect(listLocalClaudeSessionPage({}, home)).resolves.toMatchObject({
      sessions: [{ threadId: sessionId, customGroup: "Release", source: "claude-desktop" }],
    });
  });

  it("retains the current Claude Desktop pull request when history is truncated", async () => {
    const home = await createHome();
    const sessionId = "desktop-pull-requests";
    await writeProject({
      home,
      entries: [
        {
          sessionId,
          fullPath: path.join(home, ".claude", "projects", "-workspace", `${sessionId}.jsonl`),
          projectPath: "/work/openclaw",
          isSidechain: false,
        },
      ],
      transcripts: { [sessionId]: [message(sessionId, "user", "pull request prompt", 1)] },
    });
    await writeDesktopMetadata(home, "pull-requests", {
      sessionId: "local_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      cliSessionId: sessionId,
      cwd: "/work/openclaw",
      title: "Desktop pull requests",
      prNumber: 111772,
      prs: [
        { prNumber: 111772, state: "MERGED" },
        { prNumber: 111179, state: "MERGED", dismissed: true },
        ...Array.from({ length: 1_000 }, (_value, index) => ({
          prNumber: index + 1,
          state: "CLOSED",
        })),
      ],
    });

    await expect(listLocalClaudeSessionPage({}, home)).resolves.toMatchObject({
      sessions: [
        {
          threadId: sessionId,
          pullRequest: {
            numbers: [...Array.from({ length: 19 }, (_value, index) => index + 982), 111772],
            state: "merged",
          },
          source: "claude-desktop",
        },
      ],
    });
  });

  it("adds the current Claude Desktop pull request when history omits it", async () => {
    const home = await createHome();
    const sessionId = "desktop-current-pull-request";
    await writeProject({
      home,
      entries: [
        {
          sessionId,
          fullPath: path.join(home, ".claude", "projects", "-workspace", `${sessionId}.jsonl`),
          projectPath: "/work/openclaw",
          isSidechain: false,
        },
      ],
      transcripts: { [sessionId]: [message(sessionId, "user", "draft prompt", 1)] },
    });
    await writeDesktopMetadata(home, "current-pull-request", {
      sessionId: "local_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      cliSessionId: sessionId,
      cwd: "/work/openclaw",
      title: "Desktop pull request",
      prNumber: 107302,
      prState: "OPEN",
      prs: [{ prNumber: 107301, state: "CLOSED" }],
    });

    await expect(listLocalClaudeSessionPage({}, home)).resolves.toMatchObject({
      sessions: [
        {
          threadId: sessionId,
          pullRequest: { numbers: [107301, 107302], state: "open" },
          source: "claude-desktop",
        },
      ],
    });
  });

  it("skips custom group names spliced with decoder garbage", async () => {
    const home = await createHome();
    const sessionId = "desktop-garbage-group";
    const localSessionId = "local_33333333-3333-3333-3333-333333333333";
    const groupId = "cg-44444444-4444-4444-4444-444444444444";
    await writeProject({
      home,
      entries: [
        {
          sessionId,
          fullPath: path.join(home, ".claude", "projects", "-workspace", `${sessionId}.jsonl`),
          projectPath: "/work/openclaw",
          isSidechain: false,
        },
      ],
      transcripts: { [sessionId]: [message(sessionId, "user", "garbage group prompt", 1)] },
    });
    await writeDesktopMetadata(home, "garbage-group", {
      sessionId: localSessionId,
      cliSessionId: sessionId,
      cwd: "/work/openclaw",
      title: "Desktop garbage group",
    });
    // Keep the control-byte guard as defense in depth for malformed decoded values.
    await writeDesktopGroupStoreEntries(home, [
      {
        sequence: 1,
        value:
          `{"id":"${groupId}","name":"Rele\u0012)\fase"}` +
          `{"id":"${groupId}","name":"Release"}` +
          `{"code:${localSessionId}":"${groupId}"}`,
      },
    ]);

    await expect(listLocalClaudeSessionPage({}, home)).resolves.toMatchObject({
      sessions: [{ threadId: sessionId, customGroup: "Release", source: "claude-desktop" }],
    });
  });

  it("uses the highest-sequence Claude Desktop custom group value", async () => {
    const home = await createHome();
    const sessionId = "desktop-newest-custom-group";
    const localSessionId = "local_55555555-5555-5555-5555-555555555555";
    const groupId = "cg-66666666-6666-6666-6666-666666666666";
    await writeProject({
      home,
      entries: [
        {
          sessionId,
          fullPath: path.join(home, ".claude", "projects", "-workspace", `${sessionId}.jsonl`),
          projectPath: "/work/openclaw",
          isSidechain: false,
        },
      ],
      transcripts: { [sessionId]: [message(sessionId, "user", "newest group prompt", 1)] },
    });
    await writeDesktopMetadata(home, "newest-custom-group", {
      sessionId: localSessionId,
      cliSessionId: sessionId,
      cwd: "/work/openclaw",
      title: "Desktop newest custom group",
    });
    await writeDesktopGroupStoreEntries(home, [
      {
        sequence: 1,
        value: `{"id":"${groupId}","name":"Old"}{"code:${localSessionId}":"${groupId}"}`,
      },
      {
        sequence: 2,
        value: `{"id":"${groupId}","name":"New"}{"code:${localSessionId}":"${groupId}"}`,
      },
    ]);

    await expect(listLocalClaudeSessionPage({}, home)).resolves.toMatchObject({
      sessions: [{ threadId: sessionId, customGroup: "New", source: "claude-desktop" }],
    });
  });

  it("reads custom groups from a UTF-16 encoded Local Storage value", async () => {
    const home = await createHome();
    const sessionId = "desktop-utf16-group";
    const localSessionId = "local_77777777-7777-7777-7777-777777777777";
    const groupId = "cg-88888888-8888-8888-8888-888888888888";
    await writeProject({
      home,
      entries: [
        {
          sessionId,
          fullPath: path.join(home, ".claude", "projects", "-workspace", `${sessionId}.jsonl`),
          projectPath: "/work/openclaw",
          isSidechain: false,
        },
      ],
      transcripts: { [sessionId]: [message(sessionId, "user", "utf16 group prompt", 1)] },
    });
    await writeDesktopMetadata(home, "utf16-group", {
      sessionId: localSessionId,
      cliSessionId: sessionId,
      cwd: "/work/openclaw",
      title: "Desktop utf16 group",
    });
    // Chromium switches a whole value to UTF-16 when any character escapes Latin-1,
    // so the ASCII JSON arrives with interleaved NUL bytes.
    const records = `{"id":"${groupId}","name":"Release"}{"code:${localSessionId}":"${groupId}"}`;
    await writeDesktopGroupStoreEntries(home, [
      { sequence: 1, value: Buffer.from(records, "utf16le") },
    ]);

    await expect(listLocalClaudeSessionPage({}, home)).resolves.toMatchObject({
      sessions: [{ threadId: sessionId, customGroup: "Release", source: "claude-desktop" }],
    });
  });

  it("drops custom groups once a newer entry no longer carries them", async () => {
    const home = await createHome();
    const sessionId = "desktop-deleted-group";
    const localSessionId = "local_99999999-9999-9999-9999-999999999999";
    const groupId = "cg-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    await writeProject({
      home,
      entries: [
        {
          sessionId,
          fullPath: path.join(home, ".claude", "projects", "-workspace", `${sessionId}.jsonl`),
          projectPath: "/work/openclaw",
          isSidechain: false,
        },
      ],
      transcripts: { [sessionId]: [message(sessionId, "user", "deleted group prompt", 1)] },
    });
    await writeDesktopMetadata(home, "deleted-group", {
      sessionId: localSessionId,
      cliSessionId: sessionId,
      cwd: "/work/openclaw",
      title: "Desktop deleted group",
    });
    // Removing the last custom group rewrites the store without any records; the older
    // value must not win on sequence.
    await writeDesktopGroupStoreEntries(home, [
      {
        sequence: 1,
        value: `{"id":"${groupId}","name":"Release"}{"code:${localSessionId}":"${groupId}"}`,
      },
      { sequence: 2, value: "{}" },
    ]);

    const page = await listLocalClaudeSessionPage({}, home);
    expect(page.sessions[0]).toMatchObject({ threadId: sessionId, source: "claude-desktop" });
    expect(page.sessions[0]).not.toHaveProperty("customGroup");
  });

  it("discovers CLI fallback transcripts and rejects sidechains, foreign entrypoints, and escapes", async () => {
    const home = await createHome();
    const projectDir = path.join(home, ".claude", "projects", "-workspace");
    const escapedId = "escaped-session";
    const escapedPath = path.join(projectDir, `${escapedId}.jsonl`);
    const externalPath = path.join(home, "outside.jsonl");
    await writeProject({
      home,
      entries: [
        {
          sessionId: "sidechain-session",
          fullPath: path.join(projectDir, "sidechain-session.jsonl"),
          isSidechain: true,
        },
        { sessionId: escapedId, fullPath: escapedPath, isSidechain: false },
      ],
      transcripts: {
        "sidechain-session": [message("sidechain-session", "user", "sidechain", 1)],
        "unindexed-session": [message("unindexed-session", "user", "unindexed", 1)],
        "cli-session": [
          {
            ...message("cli-session", "user", "Interactive CLI prompt", 1),
            entrypoint: "cli",
            cwd: "/work/cli",
            version: "2.1.216",
          },
        ],
        "sdk-cli-session": [
          {
            ...message("sdk-cli-session", "user", "Headless CLI prompt", 1),
            entrypoint: "sdk-cli",
            cwd: "/work/sdk",
            version: "2.1.204",
          },
        ],
        "cli-sidechain-session": [
          {
            ...message("cli-sidechain-session", "user", "interactive sidechain", 1),
            entrypoint: "cli",
            isSidechain: true,
          },
        ],
        "discovered-sidechain": [
          {
            ...message("discovered-sidechain", "user", "headless sidechain", 1),
            entrypoint: "sdk-cli",
            isSidechain: true,
          },
        ],
        "foreign-entrypoint-session": [
          {
            ...message("foreign-entrypoint-session", "user", "SDK session", 1),
            entrypoint: "sdk-ts",
          },
        ],
      },
    });
    await fs.writeFile(
      externalPath,
      `${JSON.stringify(message(escapedId, "user", "outside", 1))}\n`,
    );
    await fs.symlink(externalPath, escapedPath);
    await writeDesktopMetadata(home, "sidechain", {
      cliSessionId: "sidechain-session",
      title: "Desktop sidechain",
      isArchived: false,
    });
    await writeDesktopMetadata(home, "cli-sidechain", {
      cliSessionId: "cli-sidechain-session",
      title: "Interactive Desktop sidechain",
      isArchived: false,
    });
    await writeDesktopMetadata(home, "discovered-sidechain", {
      cliSessionId: "discovered-sidechain",
      title: "Headless Desktop sidechain",
      isArchived: false,
    });

    const sessions = (await listLocalClaudeSessionPage({}, home)).sessions;
    expect(sessions.map((session) => session.threadId).toSorted()).toEqual([
      "cli-session",
      "sdk-cli-session",
    ]);
    expect(sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          threadId: "cli-session",
          name: "Interactive CLI prompt",
          source: "claude-cli",
        }),
        expect.objectContaining({
          threadId: "sdk-cli-session",
          name: "Headless CLI prompt",
          source: "claude-cli",
        }),
      ]),
    );
    for (const [threadId, text] of [
      ["cli-session", "Interactive CLI prompt"],
      ["sdk-cli-session", "Headless CLI prompt"],
    ] as const) {
      await expect(readLocalClaudeTranscriptPage({ threadId, limit: 1 }, home)).resolves.toEqual(
        expect.objectContaining({ items: [expect.objectContaining({ text })] }),
      );
    }
    for (const threadId of [
      "sidechain-session",
      "cli-sidechain-session",
      "discovered-sidechain",
      "foreign-entrypoint-session",
      "unindexed-session",
      escapedId,
    ]) {
      await expect(readLocalClaudeTranscriptPage({ threadId, limit: 1 }, home)).rejects.toThrow(
        "Claude session is unavailable",
      );
    }
  });

  it("reuses cached metadata for unchanged discovered transcripts", async () => {
    const home = await createHome();
    const sessionIds = ["cached-session-a", "cached-session-b"];
    await writeProject({
      home,
      entries: [],
      transcripts: Object.fromEntries(
        sessionIds.map((sessionId) => [sessionId, [sdkCliMessage(sessionId, sessionId)]]),
      ),
    });
    const openSpy = vi.spyOn(fs, "open");

    const first = await listLocalClaudeSessionPage({}, home);
    expect(openSpy).toHaveBeenCalledTimes(2);
    openSpy.mockClear();

    const second = await listLocalClaudeSessionPage({}, home);
    expect(second).toEqual(first);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("rescans only a changed transcript and refreshes a negative result", async () => {
    const home = await createHome();
    const projectDir = path.join(home, ".claude", "projects", "-workspace");
    const changedPath = path.join(projectDir, "changed-session.jsonl");
    const unchangedPath = path.join(projectDir, "unchanged-session.jsonl");
    await writeProject({
      home,
      entries: [],
      transcripts: {
        "changed-session": [],
        "unchanged-session": [sdkCliMessage("unchanged-session", "Unchanged")],
      },
    });
    const openSpy = vi.spyOn(fs, "open");
    expect((await listLocalClaudeSessionPage({}, home)).sessions).toHaveLength(1);
    await fs.appendFile(
      changedPath,
      `${JSON.stringify(sdkCliMessage("changed-session", "Now discovered"))}\n`,
    );
    const changedTime = new Date(Date.now() + 2_000);
    await fs.utimes(changedPath, changedTime, changedTime);
    const resolvedChangedPath = await fs.realpath(changedPath);
    const resolvedUnchangedPath = await fs.realpath(unchangedPath);
    openSpy.mockClear();

    const refreshed = await listLocalClaudeSessionPage({}, home);
    expect(refreshed.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ threadId: "changed-session", name: "Now discovered" }),
        expect.objectContaining({ threadId: "unchanged-session", name: "Unchanged" }),
      ]),
    );
    expect(openSpy.mock.calls.map(([filePath]) => filePath)).toEqual([resolvedChangedPath]);
    expect(openSpy.mock.calls.map(([filePath]) => filePath)).not.toContain(resolvedUnchangedPath);
  });

  it("discovers a new transcript without rereading cached siblings", async () => {
    const home = await createHome();
    const projectDir = path.join(home, ".claude", "projects", "-workspace");
    const newPath = path.join(projectDir, "new-session.jsonl");
    await writeProject({
      home,
      entries: [],
      transcripts: { "existing-session": [sdkCliMessage("existing-session", "Existing")] },
    });
    const openSpy = vi.spyOn(fs, "open");
    await listLocalClaudeSessionPage({}, home);
    await fs.writeFile(newPath, `${JSON.stringify(sdkCliMessage("new-session", "New"))}\n`);
    const resolvedNewPath = await fs.realpath(newPath);
    openSpy.mockClear();

    const refreshed = await listLocalClaudeSessionPage({}, home);
    expect(refreshed.sessions.map((record) => record.threadId).toSorted()).toEqual([
      "existing-session",
      "new-session",
    ]);
    expect(openSpy.mock.calls.map(([filePath]) => filePath)).toEqual([resolvedNewPath]);
  });

  it("evicts a deleted transcript after a complete scan", async () => {
    const home = await createHome();
    const projectDir = path.join(home, ".claude", "projects", "-workspace");
    const sessionId = "deleted-session";
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
    const fixedTime = new Date("2026-07-10T12:00:00.000Z");
    await writeProject({
      home,
      entries: [],
      transcripts: { [sessionId]: [sdkCliMessage(sessionId, "Alpha")] },
    });
    await fs.utimes(transcriptPath, fixedTime, fixedTime);
    const originalStat = await fs.stat(transcriptPath);
    await listLocalClaudeSessionPage({}, home);

    await fs.rm(transcriptPath);
    expect((await listLocalClaudeSessionPage({}, home)).sessions).toEqual([]);
    await fs.writeFile(transcriptPath, `${JSON.stringify(sdkCliMessage(sessionId, "Bravo"))}\n`);
    await fs.utimes(transcriptPath, fixedTime, fixedTime);
    const recreatedStat = await fs.stat(transcriptPath);
    expect({ mtimeMs: recreatedStat.mtimeMs, size: recreatedStat.size }).toEqual({
      mtimeMs: originalStat.mtimeMs,
      size: originalStat.size,
    });
    const openSpy = vi.spyOn(fs, "open");

    expect((await listLocalClaudeSessionPage({}, home)).sessions).toEqual([
      expect.objectContaining({ threadId: sessionId, name: "Bravo" }),
    ]);
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it("reads newest transcript messages first by page while returning each page chronologically", async () => {
    const home = await createHome();
    const sessionId = "transcript-session";
    const oldUser = await writeLongPagedTranscript({ home, sessionId });

    const latest = await readLocalClaudeTranscriptPage({ threadId: sessionId, limit: 2 }, home);
    expect(latest.items.map((item) => item.text)).toEqual(["new assistant", "new user"]);
    expect(latest.nextCursor).toEqual(expect.any(String));

    const older = await readLocalClaudeTranscriptPage(
      { threadId: sessionId, limit: 2, cursor: latest.nextCursor },
      home,
    );
    expect(older.items.map((item) => item.text)).toEqual(["old assistant", oldUser]);
    expect(older.nextCursor).toBeUndefined();
    await expect(
      readLocalClaudeTranscriptPage(
        { threadId: sessionId, limit: 1, cursor: ` ${latest.nextCursor} ` },
        home,
      ),
    ).rejects.toThrow("transcript cursor is invalid");
    await expect(
      readLocalClaudeTranscriptPage({ threadId: sessionId, cursor: " ", limit: 1 }, home),
    ).rejects.toThrow("transcript cursor is invalid");
    await expect(
      readLocalClaudeTranscriptPage({ threadId: sessionId, cursor: null, limit: 1 }, home),
    ).rejects.toThrow("transcript cursor is invalid");
  });

  it("rejects malformed provider read cursors before paired-node I/O", async () => {
    const listNodes = vi.fn(async () => ({ nodes: [] }));
    const provider = captureCatalogProvider({
      nodes: { list: listNodes },
    } as unknown as PluginRuntime);

    for (const cursor of ["", " wrapped ", "x".repeat(257)]) {
      await expect(
        provider.read({
          hostId: "node:node-a",
          threadId: "session-a",
          cursor,
          limit: 1,
        }),
      ).rejects.toThrow("transcript cursor is invalid");
    }
    expect(listNodes).not.toHaveBeenCalled();
  });

  it("forwards paired-node cursors exactly and rejects malformed response cursors", async () => {
    const catalogCursor = "catalog+/=_cursor";
    const transcriptCursor = "transcript+/=_cursor";
    let catalogNextCursor = "catalog+/=_next";
    let transcriptNextCursor = "transcript+/=_next";
    const invoke = vi.fn(async ({ command }: Parameters<PluginRuntime["nodes"]["invoke"]>[0]) => ({
      payloadJSON: JSON.stringify(
        command === CLAUDE_SESSIONS_LIST_COMMAND
          ? { sessions: [], nextCursor: catalogNextCursor }
          : { threadId: "session-a", items: [], nextCursor: transcriptNextCursor },
      ),
    }));
    const provider = captureCatalogProvider({
      nodes: {
        list: vi.fn(async () => ({
          nodes: [
            {
              nodeId: "node-a",
              connected: true,
              commands: [CLAUDE_SESSIONS_LIST_COMMAND, CLAUDE_SESSION_READ_COMMAND],
            },
          ],
        })),
        invoke,
      },
    } as unknown as PluginRuntime);

    await expect(
      provider.list({ hostIds: ["node:node-a"], cursors: { "node:node-a": catalogCursor } }),
    ).resolves.toMatchObject([{ nextCursor: catalogNextCursor }]);
    expect(invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: CLAUDE_SESSIONS_LIST_COMMAND,
        params: expect.objectContaining({ cursor: catalogCursor }),
      }),
    );

    await expect(
      provider.read({
        hostId: "node:node-a",
        threadId: "session-a",
        cursor: transcriptCursor,
        limit: 1,
      }),
    ).resolves.toMatchObject({ nextCursor: transcriptNextCursor });
    expect(invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: CLAUDE_SESSION_READ_COMMAND,
        params: expect.objectContaining({ cursor: transcriptCursor }),
      }),
    );

    catalogNextCursor = " wrapped ";
    await expect(provider.list({ hostIds: ["node:node-a"] })).resolves.toMatchObject([
      { error: { code: "NODE_INVOKE_FAILED" } },
    ]);
    transcriptNextCursor = " ";
    await expect(
      provider.read({ hostId: "node:node-a", threadId: "session-a", limit: 1 }),
    ).rejects.toThrow("Claude node returned an invalid transcript page");
  });

  it("pages transcripts identically when every reverse-scan read returns short", async () => {
    const home = await createHome();
    const sessionId = "short-read-session";
    const oldUser = await writeLongPagedTranscript({ home, sessionId });

    // The fixture spans multiple 128 KiB windows; each is filled in 4 KiB reads.
    injectTranscriptShortReads(sessionId, ({ length }) => Math.min(length, 4096));

    const latest = await readLocalClaudeTranscriptPage({ threadId: sessionId, limit: 2 }, home);
    expect(latest.items.map((item) => item.text)).toEqual(["new assistant", "new user"]);
    expect(latest.nextCursor).toEqual(expect.any(String));

    const older = await readLocalClaudeTranscriptPage(
      { threadId: sessionId, limit: 2, cursor: latest.nextCursor },
      home,
    );
    expect(older.items.map((item) => item.text)).toEqual(["old assistant", oldUser]);
    expect(older.nextCursor).toBeUndefined();
  });

  it("still reports a truncated transcript when a reverse-scan read hits EOF mid-window", async () => {
    const home = await createHome();
    const sessionId = "truncated-read-session";
    await writeLongPagedTranscript({ home, sessionId, truncated: true });

    // Return one partial reverse read, then simulate truncation with zero bytes.
    injectTranscriptShortReads(sessionId, ({ length, call, firstPosition }) =>
      firstPosition === 0 ? length : call === 0 ? Math.min(length, 8) : 0,
    );

    await expect(
      readLocalClaudeTranscriptPage({ threadId: sessionId, limit: 2 }, home),
    ).rejects.toThrow("Claude transcript changed while it was being read");
  });

  it("advertises terminal resume only when the store and Claude binary exist", async () => {
    const home = await createHome();
    const commands = createClaudeSessionNodeHostCommands();
    expect(commands.map((command) => command.command)).toEqual([
      CLAUDE_SESSIONS_LIST_COMMAND,
      CLAUDE_SESSION_READ_COMMAND,
      CLAUDE_TERMINAL_RESUME_COMMAND,
    ]);
    expect(commands.every((command) => command.dangerous === false)).toBe(true);
    await expect(commands[0]?.handle(JSON.stringify({ cursor: " wrapped " }))).rejects.toThrow(
      "catalog cursor is invalid",
    );
    const policy = createClaudeSessionNodeInvokePolicies()[0];
    expect(policy?.commands).toEqual([
      CLAUDE_SESSIONS_LIST_COMMAND,
      CLAUDE_SESSION_READ_COMMAND,
      CLAUDE_CLI_NODE_RUN_COMMAND,
      CLAUDE_TERMINAL_RESUME_COMMAND,
    ]);
    if (!policy) {
      throw new Error("expected Claude node invoke policy");
    }
    const invokeNode = vi.fn(async () => ({ ok: true as const, payload: "listed" }));
    expect(policy.handle({ command: CLAUDE_TERMINAL_RESUME_COMMAND, invokeNode } as never)).toEqual(
      { ok: true },
    );
    expect(invokeNode).not.toHaveBeenCalled();
    await expect(
      policy.handle({ command: CLAUDE_SESSIONS_LIST_COMMAND, invokeNode } as never),
    ).resolves.toEqual({ ok: true, payload: "listed" });
    expect(invokeNode).toHaveBeenCalledOnce();
    const availabilityContext = { config: {}, env: { HOME: home } } as never;
    expect(commands.every((command) => command.isAvailable?.(availabilityContext))).toBe(false);
    await fs.mkdir(path.join(home, ".claude", "projects"), { recursive: true });
    expect(
      commands.slice(0, 2).every((command) => command.isAvailable?.(availabilityContext)),
    ).toBe(true);
    expect(commands[2]?.isAvailable?.(availabilityContext)).toBe(false);
    const binDir = path.join(home, "bin");
    await fs.mkdir(binDir);
    await fs.writeFile(path.join(binDir, "claude"), "#!/bin/sh\n");
    await fs.chmod(path.join(binDir, "claude"), 0o755);
    expect(
      commands[2]?.isAvailable?.({ config: {}, env: { HOME: home, PATH: binDir } } as never),
    ).toBe(true);

    const terminalCommand = commands[2];
    if (!terminalCommand || terminalCommand.duplex !== true) {
      throw new Error("expected duplex Claude terminal command");
    }
    await expect(
      terminalCommand.handle(JSON.stringify({ threadId: "--bad", cols: 80, rows: 24 }), {
        signal: new AbortController().signal,
        emitChunk: async () => {},
        onInput: () => {},
      }),
    ).rejects.toThrow("threadId must be a Claude session id");

    const registerSessionCatalog = vi.fn();
    const api = {
      runtime: {},
      registerSessionCatalog,
    } as unknown as OpenClawPluginApi;
    registerClaudeSessionCatalog(api);
    expect(registerSessionCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ id: "claude", label: "Claude Code" }),
    );
  });

  it("resolves Claude terminal eligibility and cwd from the node-owned catalog", async () => {
    const home = await createHome();
    process.env.HOME = home;
    const threadId = "node-owned-session";
    await writeProject({
      home,
      entries: [
        {
          sessionId: threadId,
          fullPath: path.join(home, ".claude", "projects", "-workspace", `${threadId}.jsonl`),
          projectPath: "/node/catalog/cwd",
          summary: "Node-owned session",
        },
      ],
      transcripts: { [threadId]: [message(threadId, "user", "hello", 1)] },
    });
    const binDir = path.join(home, "bin");
    await fs.mkdir(binDir);
    const daemonExecutable = path.join(
      binDir,
      process.platform === "win32" ? "claude.cmd" : "claude",
    );
    await fs.writeFile(
      daemonExecutable,
      process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\nexit 1\n",
    );
    if (process.platform !== "win32") {
      await fs.chmod(daemonExecutable, 0o755);
    }
    process.env.PATH = binDir;
    const shellBinDir = path.join(home, "shell-bin");
    await fs.mkdir(shellBinDir);
    const shellExecutable = path.join(
      shellBinDir,
      process.platform === "win32" ? "claude.cmd" : "claude",
    );
    await fs.writeFile(
      shellExecutable,
      process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\nexit 0\n",
    );
    if (process.platform !== "win32") {
      await fs.chmod(shellExecutable, 0o755);
    }
    nodeHostMocks.userShellPaths.set("claude", shellBinDir);
    const command = createClaudeSessionNodeHostCommands().find(
      (candidate) => candidate.command === CLAUDE_TERMINAL_RESUME_COMMAND,
    );
    if (!command || command.duplex !== true) {
      throw new Error("expected duplex Claude terminal command");
    }

    await command.handle(JSON.stringify({ threadId, cwd: "/caller/cwd", cols: 80, rows: 24 }), {
      signal: new AbortController().signal,
      emitChunk: async () => {},
      onInput: () => {},
    });

    expect(nodeHostMocks.runNodePtyCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        file: shellExecutable,
        cwd: "/node/catalog/cwd",
        pathEnv: shellBinDir,
      }),
      expect.any(Object),
    );
    await expect(
      command.handle(JSON.stringify({ threadId: "missing", cols: 80, rows: 24 }), {
        signal: new AbortController().signal,
        emitChunk: async () => {},
        onInput: () => {},
      }),
    ).rejects.toThrow("Claude session cannot be resumed in a terminal");
  });

  it("replaces a broken npm shim with Claude Desktop's newest native binary", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const home = await createHome();
    process.env.HOME = home;
    const sessionId = "claude-session-1";
    await writeProject({
      home,
      entries: [
        {
          sessionId,
          fullPath: path.join(home, ".claude", "projects", "-workspace", `${sessionId}.jsonl`),
          projectPath: home,
          summary: "Resume session",
        },
      ],
      transcripts: { [sessionId]: [message(sessionId, "user", "hello", 1)] },
    });
    const daemonBinDir = path.join(home, "daemon-bin");
    const shellBinDir = path.join(home, "shell-bin");
    await fs.mkdir(daemonBinDir);
    await fs.mkdir(shellBinDir);
    const daemonExecutable = path.join(
      daemonBinDir,
      process.platform === "win32" ? "claude.cmd" : "claude",
    );
    await fs.writeFile(
      daemonExecutable,
      process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\nexit 1\n",
    );
    if (process.platform !== "win32") {
      await fs.chmod(daemonExecutable, 0o755);
    }
    process.env.PATH = daemonBinDir;
    let provider: SessionCatalogProvider | undefined;
    registerClaudeSessionCatalog({
      id: "anthropic",
      config: {},
      runtime: {
        config: { current: () => ({}) },
        nodes: { list: async () => ({ nodes: [] }) },
        agent: { session: { listSessionEntries: () => [] } },
      },
      registerSessionCatalog: (candidate: SessionCatalogProvider) => {
        provider = candidate;
      },
    } as unknown as OpenClawPluginApi);

    await writeBrokenClaudeNpmShim(shellBinDir);
    nodeHostMocks.userShellPaths.set("claude", shellBinDir);
    const desktopVersionRoot = path.join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude-code",
    );
    for (const version of ["2.1.9", "2.1.10"]) {
      const desktopBinDir = path.join(
        desktopVersionRoot,
        version,
        "claude.app",
        "Contents",
        "MacOS",
      );
      await fs.mkdir(desktopBinDir, { recursive: true });
      await fs.writeFile(path.join(desktopBinDir, "claude"), "#!/bin/sh\nexit 0\n");
      await fs.chmod(path.join(desktopBinDir, "claude"), 0o755);
    }
    const desktopExecutable = path.join(
      desktopVersionRoot,
      "2.1.10",
      "claude.app",
      "Contents",
      "MacOS",
      "claude",
    );
    await expect(provider?.list({})).resolves.toMatchObject([
      { sessions: [{ threadId: sessionId, canOpenTerminal: true }] },
    ]);
    await expect(
      provider?.openTerminal?.({ hostId: "gateway:local", threadId: sessionId }),
    ).resolves.toMatchObject({
      kind: "local",
      argv: [desktopExecutable, "--resume", sessionId],
      cwd: home,
      pathEnv: shellBinDir,
    });
    await expect(
      provider?.openTerminal?.({ hostId: "gateway:local", threadId: "missing" }),
    ).rejects.toThrow("Claude session is unavailable");
  });

  it("hides terminal capability when the failed npm shim has no native replacement", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const home = await createHome();
    process.env.HOME = home;
    const sessionId = "claude-session-broken-shim";
    await writeProject({
      home,
      entries: [
        {
          sessionId,
          fullPath: path.join(home, ".claude", "projects", "-workspace", `${sessionId}.jsonl`),
          projectPath: home,
          summary: "Broken shim session",
        },
      ],
      transcripts: { [sessionId]: [message(sessionId, "user", "hello", 1)] },
    });
    const shellBinDir = path.join(home, "shell-bin");
    await writeBrokenClaudeNpmShim(shellBinDir);
    process.env.PATH = shellBinDir;
    nodeHostMocks.userShellPaths.set("claude", shellBinDir);
    const provider = captureCatalogProvider({
      config: { current: () => ({}) },
      nodes: { list: async () => ({ nodes: [] }) },
    } as unknown as PluginRuntime);

    await expect(provider.list({})).resolves.toMatchObject([
      { sessions: [{ threadId: sessionId, canOpenTerminal: false }] },
    ]);
    await expect(
      provider.openTerminal?.({ hostId: "gateway:local", threadId: sessionId }),
    ).rejects.toThrow("Claude CLI is unavailable");
  });

  it("keeps one failed node isolated from healthy hosts", async () => {
    const runtime = {
      nodes: {
        list: vi.fn().mockResolvedValue({
          nodes: [
            {
              nodeId: "healthy",
              displayName: "Healthy",
              connected: true,
              commands: [CLAUDE_SESSIONS_LIST_COMMAND],
            },
            {
              nodeId: "failed",
              displayName: "Failed",
              connected: true,
              commands: [CLAUDE_SESSIONS_LIST_COMMAND],
            },
          ],
        }),
        invoke: vi.fn().mockImplementation(({ nodeId }: { nodeId: string }) => {
          if (nodeId === "failed") {
            throw new Error("offline");
          }
          return { payloadJSON: JSON.stringify({ sessions: [] }) };
        }),
      },
    } as unknown as PluginRuntime;

    const provider = captureCatalogProvider(runtime);
    const hosts = await provider.list({ hostIds: ["node:healthy", "node:failed"] });
    expect(hosts).toEqual([
      expect.objectContaining({ hostId: "node:failed", error: expect.any(Object) }),
      expect.objectContaining({ hostId: "node:healthy", sessions: [] }),
    ]);
  });

  it("bounds how long a hung paired-node catalog can delay the caller", async () => {
    vi.useFakeTimers();
    try {
      const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(
        async () => await new Promise<never>(() => {}),
      );
      const provider = captureCatalogProvider({
        nodes: {
          list: vi.fn().mockResolvedValue({
            nodes: [
              {
                nodeId: "slow-node",
                displayName: "Slow node",
                connected: true,
                commands: [CLAUDE_SESSIONS_LIST_COMMAND],
              },
            ],
          }),
          invoke,
        },
      } as unknown as PluginRuntime);
      const pending = provider.list({ hostIds: ["node:slow-node"] });

      await vi.advanceTimersByTimeAsync(8_000);

      await expect(pending).resolves.toEqual([
        expect.objectContaining({
          hostId: "node:slow-node",
          connected: true,
          sessions: [],
          error: expect.objectContaining({ code: "NODE_INVOKE_FAILED" }),
        }),
      ]);
      expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 30_000 }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes a paired-node page that finishes after the fail-soft response", async () => {
    vi.useFakeTimers();
    try {
      let resolveInvoke!: (value: unknown) => void;
      const invokeResult = new Promise<unknown>((resolve) => {
        resolveInvoke = resolve;
      });
      const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async () => await invokeResult);
      const provider = captureCatalogProvider({
        nodes: {
          list: vi.fn().mockResolvedValue({
            nodes: [
              {
                nodeId: "slow-node",
                displayName: "Slow node",
                connected: true,
                commands: [CLAUDE_SESSIONS_LIST_COMMAND],
              },
            ],
          }),
          invoke,
        },
      } as unknown as PluginRuntime);
      const onHost = vi.fn();
      const pending = provider.list({ hostIds: ["node:slow-node"], onHost });

      await vi.advanceTimersByTimeAsync(8_000);
      await expect(pending).resolves.toEqual([
        expect.objectContaining({ error: expect.objectContaining({ code: "NODE_INVOKE_FAILED" }) }),
      ]);
      expect(onHost).not.toHaveBeenCalled();

      resolveInvoke({
        payloadJSON: JSON.stringify({
          sessions: [
            {
              threadId: "late-thread",
              status: "stored",
              source: "claude-cli",
              modelProvider: "anthropic",
              archived: false,
            },
          ],
        }),
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(onHost).toHaveBeenCalledWith(
        expect.objectContaining({
          hostId: "node:slow-node",
          sessions: [expect.objectContaining({ threadId: "late-thread" })],
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts paired-node discovery while the local catalog is still reading", async () => {
    const home = await createHome();
    process.env.HOME = home;
    const sessionId = "concurrent-local-session";
    await writeProject({
      home,
      entries: [],
      transcripts: { [sessionId]: [sdkCliMessage(sessionId, "Local")] },
    });
    let releaseOpen = () => {};
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    let reportOpen = () => {};
    const opened = new Promise<void>((resolve) => {
      reportOpen = resolve;
    });
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      reportOpen();
      await openGate;
      return await originalOpen(...args);
    });
    const listNodes = vi.fn(async () => ({ nodes: [] }));
    const provider = captureCatalogProvider({
      nodes: { list: listNodes },
    } as unknown as PluginRuntime);

    const listing = provider.list({});
    await opened;
    expect(listNodes).toHaveBeenCalledOnce();
    releaseOpen();
    await expect(listing).resolves.toMatchObject([
      { hostId: "gateway:local", sessions: [expect.objectContaining({ threadId: sessionId })] },
    ]);
  });

  it("keeps the underlying paired-node list failure", async () => {
    const runtime = {
      nodes: {
        list: vi.fn().mockRejectedValue(new Error("paired store is unreadable")),
      },
    } as unknown as PluginRuntime;

    const provider = captureCatalogProvider(runtime);
    const hosts = await provider.list({ hostIds: ["node:registry"] });

    expect(hosts).toEqual([
      expect.objectContaining({
        hostId: "node:registry",
        error: {
          code: "NODE_LIST_FAILED",
          message: "Paired nodes could not be listed: paired store is unreadable",
        },
      }),
    ]);
  });

  it("rejects malformed fields returned by a paired node", async () => {
    const runtime = {
      nodes: {
        list: vi.fn().mockResolvedValue({
          nodes: [
            {
              nodeId: "malformed",
              displayName: "Malformed",
              connected: true,
              commands: [CLAUDE_SESSIONS_LIST_COMMAND],
            },
          ],
        }),
        invoke: vi.fn().mockResolvedValue({
          payloadJSON: JSON.stringify({
            sessions: [
              {
                threadId: "session",
                name: 1,
                status: "stored",
                source: "claude-cli",
                modelProvider: "anthropic",
                archived: false,
              },
            ],
          }),
        }),
      },
    } as unknown as PluginRuntime;

    const provider = captureCatalogProvider(runtime);
    const hosts = await provider.list({ hostIds: ["node:malformed"] });
    expect(hosts).toEqual([
      expect.objectContaining({ hostId: "node:malformed", error: expect.any(Object) }),
    ]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
