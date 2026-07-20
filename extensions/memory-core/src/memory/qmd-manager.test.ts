// Memory Core tests cover qmd manager plugin behavior.
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as scheduleNativeTimeout } from "node:timers";
import { expectDefined } from "@openclaw/normalization-core";
import type {
  PluginStateLeaseContext,
  PluginStateLeaseOptions,
  PluginStateLeaseRunner,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { withMockedWindowsPlatform } from "openclaw/plugin-sdk/test-node-mocks";
import type { Mock } from "vitest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { logWarnMock, logDebugMock, logInfoMock } = vi.hoisted(() => ({
  logWarnMock: vi.fn(),
  logDebugMock: vi.fn(),
  logInfoMock: vi.fn(),
}));
const { watchMock } = vi.hoisted(() => ({
  watchMock: vi.fn(() => {
    const watcher = new EventEmitter() as EventEmitter & {
      watchedEntries: Record<string, string[]>;
    };
    watcher.watchedEntries = {};
    return Object.assign(watcher, {
      close: vi.fn(async () => undefined),
      getWatched: vi.fn(() => watcher.watchedEntries),
    });
  }),
}));
const { withLeaseMock } = vi.hoisted(() => {
  const implementation: PluginStateLeaseRunner = async <T>(
    options: PluginStateLeaseOptions,
    run: (lease: PluginStateLeaseContext) => Promise<T>,
  ) =>
    await run({
      signal: options.signal ?? new AbortController().signal,
      assertOwned: vi.fn(),
    });
  return {
    withLeaseMock: vi.fn(implementation) as Mock<PluginStateLeaseRunner> & PluginStateLeaseRunner,
  };
});
const MEMORY_EMBEDDING_PROVIDERS_KEY = Symbol.for("openclaw.memoryEmbeddingProviders");
const MCPORTER_STATE_KEY = Symbol.for("openclaw.mcporterState");
const QMD_EMBED_QUEUE_KEY = Symbol.for("openclaw.qmdEmbedQueueTail");
const QMD_UPDATE_QUEUE_KEY = Symbol.for("openclaw.qmdUpdateQueueState");
const BUILT_IN_WATCH_DEBOUNCE_MS = 1_500;

type WatchOptions = {
  ignored?: (watchPath: string) => boolean;
};

type LeaseCall = Parameters<PluginStateLeaseRunner>;

type MockStream = EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };

interface MockChild extends EventEmitter {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdout: MockStream;
  stderr: MockStream;
  kill: (signal?: NodeJS.Signals) => boolean;
  closeWith: (code?: number | null) => void;
}

function createMockChild(params?: { autoClose?: boolean; closeDelayMs?: number }): MockChild {
  const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  const child: MockChild = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    stdout,
    stderr,
    closeWith: (code: number | null = 0) => {
      child.exitCode = code;
      child.emit("close", code, child.signalCode);
    },
    kill: (signal: NodeJS.Signals = "SIGTERM") => {
      child.signalCode = signal;
      // Let timeout rejection win in tests that simulate hung QMD commands.
      return true;
    },
  });
  if (params?.autoClose !== false) {
    const delayMs = params?.closeDelayMs ?? 0;
    if (delayMs <= 0) {
      queueMicrotask(() => {
        child.emit("close", 0);
      });
    } else {
      scheduleNativeTimeout(() => {
        child.emit("close", 0);
      }, delayMs);
    }
  }
  return child;
}

function emitAndClose(child: MockChild, stream: "stdout" | "stderr", data: string, code = 0) {
  queueMicrotask(() => {
    child[stream].emit("data", data);
    child.closeWith(code);
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => {
      scheduleNativeTimeout(resolve, 10);
    });
  }
}

function isMcporterCommand(cmd: unknown): boolean {
  if (typeof cmd !== "string") {
    return false;
  }
  return /(^|[\\/])mcporter(?:\.cmd)?$/i.test(cmd);
}

function firstWatchOptions(): WatchOptions {
  const call = watchMock.mock.calls[0] as unknown as [string[], WatchOptions] | undefined;
  if (!call) {
    throw new Error("Expected watch call");
  }
  return call[1];
}

function firstWatchPaths(): string[] {
  const call = watchMock.mock.calls[0] as unknown as [string[], WatchOptions] | undefined;
  if (!call) {
    throw new Error("Expected watch call");
  }
  return call[0];
}

function firstEmbedLeaseCall(): LeaseCall {
  const call = withLeaseMock.mock.calls.find(
    (entry) => entry[0].database.scope === "shared" && entry[0].key === "embed",
  ) as LeaseCall | undefined;
  if (!call) {
    throw new Error("Expected qmd embed lease call");
  }
  return call;
}

function writeLeaseCalls(): LeaseCall[] {
  return withLeaseMock.mock.calls.filter(
    (entry) => entry[0].database.scope === "agent" && entry[0].key === "write",
  ) as LeaseCall[];
}

function firstWriteLeaseCall(): LeaseCall {
  const call = writeLeaseCalls()[0];
  if (!call) {
    throw new Error("Expected qmd store write lease call");
  }
  return call;
}

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-foundation", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/memory-core-host-engine-foundation")
  >("openclaw/plugin-sdk/memory-core-host-engine-foundation");
  return {
    ...actual,
    createSubsystemLogger: () => {
      const logger = {
        warn: logWarnMock,
        debug: logDebugMock,
        info: logInfoMock,
        child: () => logger,
      };
      return logger;
    },
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

vi.mock("chokidar", () => ({
  default: { watch: watchMock },
  watch: watchMock,
}));

import { spawn as mockedSpawn } from "node:child_process";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  type MemorySearchRuntimeDebug,
  requireNodeSqlite,
  resolveMemoryBackendConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { PluginStateLeaseError } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  formatSqliteSessionFileMarker,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { formatSessionTranscriptMemoryHitKey } from "openclaw/plugin-sdk/session-transcript-hit";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { configureMemoryCoreDreamingState } from "../dreaming-state.js";
import { resolveQmdSessionArtifactIdentity } from "../qmd-session-artifacts.js";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "../test-helpers.js";
import { parseListedQmdCollections, parseShownQmdCollection } from "./qmd-collection-metadata.js";
import { QmdMemoryManager, resolveQmdMcporterSearchProcessTimeoutMs } from "./qmd-manager.js";
import { MEMORY_SEARCH_DEADLINE_CONTROL } from "./search-deadline.js";

const spawnMock = mockedSpawn as unknown as Mock;
const originalPath = process.env.PATH;
const originalPathExt = process.env.PATHEXT;
const originalWindowsPath = process.env.Path;
const originalQmdStateDir = process.env.OPENCLAW_STATE_DIR;

function setQmdStateDir(stateDir: string): void {
  Reflect.set(process.env, "OPENCLAW_STATE_DIR", stateDir);
}

async function seedQmdSessionTranscript(params: {
  agentId: string;
  content: string;
  sessionId: string;
  stateDir: string;
  sessionKey?: string;
  timestamp?: number | string;
}): Promise<void> {
  const sessionsDir = path.join(params.stateDir, "agents", params.agentId, "sessions");
  const storePath = path.join(sessionsDir, "sessions.json");
  const sessionKey = params.sessionKey ?? `agent:${params.agentId}:qmd:${params.sessionId}`;
  const timestamp =
    typeof params.timestamp === "number"
      ? params.timestamp
      : params.timestamp
        ? Date.parse(params.timestamp)
        : Date.now();
  await fs.mkdir(sessionsDir, { recursive: true });
  await upsertSessionEntry({
    agentId: params.agentId,
    sessionKey,
    storePath,
    entry: {
      sessionId: params.sessionId,
      sessionFile: formatSqliteSessionFileMarker({
        agentId: params.agentId,
        sessionId: params.sessionId,
        storePath,
      }),
      updatedAt: timestamp,
    },
  });
  await appendSessionTranscriptMessageByIdentity({
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey,
    storePath,
    message: {
      role: "user",
      content: params.content,
      timestamp,
    },
  });
}

function restoreQmdStateDir(): void {
  if (originalQmdStateDir === undefined) {
    Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
  } else {
    Reflect.set(process.env, "OPENCLAW_STATE_DIR", originalQmdStateDir);
  }
}

describe("QmdMemoryManager", () => {
  let fixtureRoot: string;
  let fixtureCount = 0;
  let tmpRoot: string;
  let workspaceDir: string;
  let stateDir: string;
  let cfg: OpenClawConfig;
  const agentId = "main";
  const openManagers = new Set<QmdMemoryManager>();
  let embedStartupJitterSpy: { mockRestore: () => void } | null = null;

  function seedMemoryEmbeddingProviders(): void {
    (globalThis as Record<PropertyKey, unknown>)[MEMORY_EMBEDDING_PROVIDERS_KEY] = new Map([
      [
        "openai",
        {
          adapter: {
            id: "openai",
            defaultModel: "text-embedding-3-small",
            transport: "remote",
            create: async () => ({ provider: null }),
          },
        },
      ],
    ]);
  }

  function trackManager<T extends QmdMemoryManager | null>(manager: T): T {
    if (manager) {
      openManagers.add(manager);
    }
    return manager;
  }

  function requireValue<T>(value: T | null | undefined, message: string): T {
    if (value == null) {
      throw new Error(message);
    }
    return value;
  }

  function requireArgAfter(args: readonly string[], flag: string): string {
    const index = args.indexOf(flag);
    if (index < 0) {
      throw new Error(`expected ${flag} argument`);
    }
    return expectDefined(args[index + 1], `${flag} argument value`);
  }

  function mockMessages(mock: Mock): string[] {
    return mock.mock.calls.map((call: unknown[]) => String(call[0]));
  }

  function qmdCommandCalls(): string[][] {
    return spawnMock.mock.calls.map((call: unknown[]) => call[1] as string[]);
  }

  function countQmdCommand(predicate: (args: string[]) => boolean): number {
    return qmdCommandCalls().filter(predicate).length;
  }

  function expectMockMessageContains(mock: Mock, text: string): void {
    expect(mockMessages(mock).join("\n")).toContain(text);
  }

  function expectMockMessageNotContains(mock: Mock, text: string): void {
    expect(mockMessages(mock).join("\n")).not.toContain(text);
  }

  it("caps mcporter search process timeout grace", () => {
    expect(resolveQmdMcporterSearchProcessTimeoutMs(1_000)).toBe(5_000);
    expect(resolveQmdMcporterSearchProcessTimeoutMs(10_000)).toBe(12_000);
    expect(resolveQmdMcporterSearchProcessTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
    expect(resolveQmdMcporterSearchProcessTimeoutMs(Number.MAX_VALUE)).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(resolveQmdMcporterSearchProcessTimeoutMs(MAX_TIMER_TIMEOUT_MS - 100)).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
  });

  it("reuses persisted collection validation across transient cli managers", async () => {
    await configureMemoryCoreDreamingStateForTests();
    const first = await createManager({ mode: "cli" });
    await first.manager.close();
    expect(countQmdCommand((args) => args[0] === "collection" && args[1] === "list")).toBe(1);

    spawnMock.mockClear();
    const second = await createManager({ mode: "cli" });
    await second.manager.close();

    expect(countQmdCommand((args) => args[0] === "collection" && args[1] === "list")).toBe(0);
    expect(countQmdCommand((args) => args[0] === "collection" && args[1] === "show")).toBe(0);
    expect(countQmdCommand((args) => args[0] === "collection" && args[1] === "add")).toBe(0);
  });

  it("serializes same-agent initialization through cache publication", async () => {
    await configureMemoryCoreDreamingStateForTests();
    let tail = Promise.resolve();
    let active = 0;
    let maxActive = 0;
    withLeaseMock.mockImplementation(
      async <T>(
        options: PluginStateLeaseOptions,
        run: (lease: PluginStateLeaseContext) => Promise<T>,
      ) => {
        const context = {
          signal: options.signal ?? new AbortController().signal,
          assertOwned: vi.fn(),
        };
        if (options.database.scope !== "agent" || options.key !== "write") {
          return (await run(context)) as T;
        }
        const execute = async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          try {
            return (await run(context)) as T;
          } finally {
            active -= 1;
          }
        };
        const result = tail.then(execute, execute);
        tail = result.then(
          () => undefined,
          () => undefined,
        );
        return await result;
      },
    );

    const [first, second] = await Promise.all([
      createManager({ mode: "cli" }),
      createManager({ mode: "cli" }),
    ]);

    expect(maxActive).toBe(1);
    expect(countQmdCommand((args) => args[0] === "collection" && args[1] === "list")).toBe(1);
    await first.manager.close();
    await second.manager.close();
  });

  it("does not cache incomplete collection validation", async () => {
    await configureMemoryCoreDreamingStateForTests();
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "add") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stderr", "permission denied", 1);
        return child;
      }
      return createMockChild();
    });

    const first = await createManager({ mode: "cli" });
    await first.manager.close();

    spawnMock.mockClear();
    spawnMock.mockImplementation(() => createMockChild());
    const second = await createManager({ mode: "cli" });
    await second.manager.close();

    expect(countQmdCommand((args) => args[0] === "collection" && args[1] === "list")).toBe(1);
    expect(countQmdCommand((args) => args[0] === "collection" && args[1] === "add")).toBe(1);
  });

  it("runs collection validation when the runtime cache store is unavailable", async () => {
    configureMemoryCoreDreamingState(() => {
      throw new Error("state store unavailable");
    });
    try {
      const manager = await createManager({ mode: "cli" });
      await manager.manager.close();
    } finally {
      await configureMemoryCoreDreamingStateForTests();
    }

    expect(countQmdCommand((args) => args[0] === "collection" && args[1] === "list")).toBe(1);
    expect(countQmdCommand((args) => args[0] === "collection" && args[1] === "add")).toBe(1);
  });

  it("reports collection validation debug only once per validation run", async () => {
    await configureMemoryCoreDreamingStateForTests();
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "query" || args[0] === "search" || args[0] === "vsearch") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });
    const { manager } = await createManager({ mode: "cli" });
    const firstDebug: MemorySearchRuntimeDebug[] = [];
    const secondDebug: MemorySearchRuntimeDebug[] = [];

    await manager.search("fact", {
      sessionKey: "agent:main:slack:dm:u123",
      onDebug: (entry) => {
        firstDebug.push(entry);
      },
    });
    await manager.search("fact again", {
      sessionKey: "agent:main:slack:dm:u123",
      onDebug: (entry) => {
        secondDebug.push(entry);
      },
    });

    expect(firstDebug.at(-1)?.qmd?.collectionValidation?.cacheState).toBe("write");
    expect(secondDebug.at(-1)?.qmd?.collectionValidation).toBeUndefined();
  });

  it("misses collection validation cache when managed collection config changes", async () => {
    await configureMemoryCoreDreamingStateForTests();
    const first = await createManager({ mode: "cli" });
    await first.manager.close();

    const otherWorkspaceDir = path.join(tmpRoot, "other-workspace");
    await fs.mkdir(otherWorkspaceDir, { recursive: true });
    const changedCfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          ...cfg.memory?.qmd,
          paths: [{ path: otherWorkspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockClear();
    const second = await createManager({ mode: "cli", cfg: changedCfg });
    await second.manager.close();

    expect(countQmdCommand((args) => args[0] === "collection" && args[1] === "list")).toBe(1);
  });

  it("bypasses validation cache for missing-collection search repair", async () => {
    await configureMemoryCoreDreamingStateForTests();
    const { manager } = await createManager();
    spawnMock.mockClear();
    let searchAttempts = 0;
    const events: string[] = [];
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      events.push(`command:${args[0]}${args[1] ? `:${args[1]}` : ""}`);
      if (args[0] === "query" || args[0] === "search" || args[0] === "vsearch") {
        const child = createMockChild({ autoClose: false });
        searchAttempts += 1;
        if (searchAttempts === 1) {
          emitAndClose(child, "stderr", "collection workspace-main not found", 1);
        } else {
          emitAndClose(child, "stdout", "[]");
        }
        return child;
      }
      return createMockChild();
    });
    const debug: MemorySearchRuntimeDebug[] = [];

    await manager.search("fact", {
      sessionKey: "agent:main:slack:dm:u123",
      onDebug: (entry) => {
        debug.push(entry);
      },
      [MEMORY_SEARCH_DEADLINE_CONTROL]: (action) => {
        events.push(`phase:${action}`);
      },
    });

    expect(searchAttempts).toBe(2);
    expect(countQmdCommand((args) => args[0] === "collection" && args[1] === "list")).toBe(1);
    expect(debug.at(-1)?.qmd?.collectionValidation?.cacheState).toBe("bypass-force");
    expect(events.filter((event) => event.startsWith("phase:"))).toEqual([
      "phase:pause",
      "phase:resume",
      "phase:pause",
      "phase:resume",
    ]);
    const isSearchCommand = (event: string) =>
      ["command:query:", "command:search:", "command:vsearch:"].some((prefix) =>
        event.startsWith(prefix),
      );
    const firstSearch = events.findIndex(isSearchCommand);
    const firstSearchEnd = events.indexOf("phase:resume");
    const collectionRepair = events.findIndex(
      (event, index) => index > firstSearchEnd && event.startsWith("command:collection:"),
    );
    const retryStart = events.indexOf("phase:pause", firstSearchEnd + 1);
    const retrySearch = events.findIndex(
      (event, index) => index > firstSearch && isSearchCommand(event),
    );
    expect(events.indexOf("phase:pause")).toBeLessThan(firstSearch);
    expect(firstSearch).toBeLessThan(firstSearchEnd);
    expect(firstSearchEnd).toBeLessThan(collectionRepair);
    expect(collectionRepair).toBeLessThan(retryStart);
    expect(retryStart).toBeLessThan(retrySearch);
  });

  it("reuses persisted qmd multi-collection support probe across managers", async () => {
    await configureMemoryCoreDreamingStateForTests();
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          sessions: { enabled: true },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "--help") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "Usage: qmd search -c one or more collections");
        return child;
      }
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const first = await createManager({ mode: "cli" });
    await first.manager.search("fact", {
      sessionKey: "agent:main:slack:dm:u123",
    });
    await first.manager.close();
    expect(countQmdCommand((args) => args[0] === "--help")).toBe(1);

    spawnMock.mockClear();
    const second = await createManager({ mode: "cli" });
    const debug: MemorySearchRuntimeDebug[] = [];
    await second.manager.search("fact", {
      sessionKey: "agent:main:slack:dm:u123",
      onDebug: (entry) => {
        debug.push(entry);
      },
    });
    await second.manager.close();

    expect(countQmdCommand((args) => args[0] === "--help")).toBe(0);
    expect(debug.at(-1)?.qmd?.multiCollectionProbe?.cacheState).toBe("hit");
    expect(debug.at(-1)?.qmd?.searchPlan?.groupCount).toBe(2);
  });

  it("reports multi-collection probe debug only when the probe runs", async () => {
    await configureMemoryCoreDreamingStateForTests();
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          sessions: { enabled: true },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "--help") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "Usage: qmd search -c one or more collections");
        return child;
      }
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });
    const { manager } = await createManager({ mode: "cli" });
    const firstDebug: MemorySearchRuntimeDebug[] = [];
    const secondDebug: MemorySearchRuntimeDebug[] = [];

    await manager.search("fact", {
      sessionKey: "agent:main:slack:dm:u123",
      onDebug: (entry) => {
        firstDebug.push(entry);
      },
    });
    await manager.search("fact again", {
      sessionKey: "agent:main:slack:dm:u123",
      onDebug: (entry) => {
        secondDebug.push(entry);
      },
    });

    expect(firstDebug.at(-1)?.qmd?.multiCollectionProbe?.cacheState).toBe("write");
    expect(secondDebug.at(-1)?.qmd?.multiCollectionProbe).toBeUndefined();
  });

  it("keeps concurrent search debug isolated on a shared qmd manager", async () => {
    await configureMemoryCoreDreamingStateForTests();
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          sessions: { enabled: true },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    let firstSearchChild: MockChild | undefined;
    let searchCalls = 0;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        searchCalls += 1;
        const child = createMockChild({ autoClose: false });
        if (searchCalls === 1) {
          firstSearchChild = child;
          return child;
        }
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      if (args[0] === "--version") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "qmd 1.0.0");
        return child;
      }
      return createMockChild();
    });
    const { manager } = await createManager({ mode: "full" });
    const firstDebug: MemorySearchRuntimeDebug[] = [];
    const secondDebug: MemorySearchRuntimeDebug[] = [];

    const firstSearch = manager.search("memory fact", {
      sessionKey: "agent:main:slack:dm:u123",
      sources: ["memory"],
      onDebug: (entry) => {
        firstDebug.push(entry);
      },
    });
    await waitUntil(() => searchCalls === 1);
    const secondSearch = manager.search("session fact", {
      sessionKey: "agent:main:slack:dm:u123",
      sources: ["sessions"],
      onDebug: (entry) => {
        secondDebug.push(entry);
      },
    });
    await waitUntil(() => searchCalls === 2);
    emitAndClose(requireValue(firstSearchChild, "first search child missing"), "stdout", "[]");

    await Promise.all([firstSearch, secondSearch]);

    expect(firstDebug.at(-1)?.qmd?.searchPlan?.sources).toEqual(["memory"]);
    expect(secondDebug.at(-1)?.qmd?.searchPlan?.sources).toEqual(["sessions"]);
  });

  it("keeps remember-only session exports out of ordinary manager searches", async () => {
    cfg = {
      ...cfg,
      agents: {
        ...cfg.agents,
        list: [{ id: "main", memorySearch: { rememberAcrossConversations: true } }],
      },
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });
    const { manager } = await createManager({ mode: "cli" });

    await manager.search("remember-only", {
      sessionKey: "agent:main:cli:direct:memory-search",
    });

    const searchCalls = spawnMock.mock.calls
      .filter(([, args]) => args[0] === "search")
      .map(([, args]) => args);
    expect(searchCalls.some((args) => args.includes("workspace-main"))).toBe(true);
    expect(searchCalls.some((args) => args.includes("sessions-main"))).toBe(false);
    await manager.close();
  });

  it("rewrites stale multi-collection probe cache when combined filters are rejected", async () => {
    await configureMemoryCoreDreamingStateForTests();
    const otherWorkspaceDir = path.join(tmpRoot, "other-workspace");
    await fs.mkdir(otherWorkspaceDir, { recursive: true });
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [
            { path: workspaceDir, pattern: "**/*.md", name: "workspace" },
            { path: otherWorkspaceDir, pattern: "**/*.md", name: "other" },
          ],
        },
      },
    } as OpenClawConfig;
    const isCombinedSearch = (args: string[]) =>
      (args[0] === "search" || args[0] === "query") &&
      args.filter((token) => token === "-c").length > 1;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "--version") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "qmd 1.0.0");
        return child;
      }
      if (args[0] === "--help") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "Usage: qmd search -c one or more collections");
        return child;
      }
      if (isCombinedSearch(args)) {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stderr", "unknown flag: -c", 1);
        return child;
      }
      if (args[0] === "search" || args[0] === "query" || args[0] === "vsearch") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const first = await createManager({ mode: "cli" });
    const firstDebug: MemorySearchRuntimeDebug[] = [];
    await first.manager.search("fact", {
      sessionKey: "agent:main:slack:dm:u123",
      onDebug: (entry) => {
        firstDebug.push(entry);
      },
    });
    await first.manager.close();

    expect(firstDebug.at(-1)?.qmd?.multiCollectionProbe).toMatchObject({
      cacheState: "write",
      supported: false,
    });

    spawnMock.mockClear();
    const second = await createManager({ mode: "cli" });
    const secondDebug: MemorySearchRuntimeDebug[] = [];
    await second.manager.search("fact", {
      sessionKey: "agent:main:slack:dm:u123",
      onDebug: (entry) => {
        secondDebug.push(entry);
      },
    });
    await second.manager.close();

    expect(countQmdCommand((args) => args[0] === "--help")).toBe(0);
    expect(countQmdCommand(isCombinedSearch)).toBe(0);
    expect(secondDebug.at(-1)?.qmd?.multiCollectionProbe).toMatchObject({
      cacheState: "hit",
      supported: false,
    });
  });

  async function expectPathMissing(targetPath: string): Promise<void> {
    try {
      await fs.lstat(targetPath);
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
      return;
    }
    throw new Error(`expected missing path ${targetPath}`);
  }

  function qmdIndexConfigPath(selectedAgentId = agentId): string {
    return path.join(stateDir, "agents", selectedAgentId, "qmd", "xdg-config", "qmd", "index.yml");
  }

  async function createManager(params?: {
    mode?: "full" | "status" | "cli";
    cfg?: OpenClawConfig;
    agentId?: string;
  }) {
    const sourceCfg = params?.cfg ?? cfg;
    const cfgToUse: OpenClawConfig = {
      ...sourceCfg,
      agents: {
        ...sourceCfg.agents,
        defaults: {
          ...sourceCfg.agents?.defaults,
          memorySearch: {
            rememberAcrossConversations: false,
            ...sourceCfg.agents?.defaults?.memorySearch,
          },
        },
      },
    };
    const selectedAgentId = params?.agentId ?? agentId;
    const resolved = resolveMemoryBackendConfig({ cfg: cfgToUse, agentId: selectedAgentId });
    const manager = trackManager(
      await QmdMemoryManager.create({
        cfg: cfgToUse,
        agentId: selectedAgentId,
        resolved,
        withLease: withLeaseMock,
        mode: params?.mode ?? "status",
      }),
    );
    return { manager: requireValue(manager, "manager missing"), resolved };
  }

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qmd-manager-test-fixtures-"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (globalThis as Record<PropertyKey, unknown>)[MCPORTER_STATE_KEY];
    delete (globalThis as Record<PropertyKey, unknown>)[QMD_EMBED_QUEUE_KEY];
    delete (globalThis as Record<PropertyKey, unknown>)[QMD_UPDATE_QUEUE_KEY];
    delete (globalThis as Record<PropertyKey, unknown>)[MEMORY_EMBEDDING_PROVIDERS_KEY];
    spawnMock.mockClear();
    spawnMock.mockImplementation(() => createMockChild());
    watchMock.mockClear();
    withLeaseMock.mockReset();
    withLeaseMock.mockImplementation(
      async <T>(
        options: PluginStateLeaseOptions,
        run: (lease: PluginStateLeaseContext) => Promise<T>,
      ) =>
        await run({
          signal: options.signal ?? new AbortController().signal,
          assertOwned: vi.fn(),
        }),
    );
    logWarnMock.mockClear();
    logDebugMock.mockClear();
    logInfoMock.mockClear();
    tmpRoot = path.join(fixtureRoot, `case-${fixtureCount++}`);
    workspaceDir = path.join(tmpRoot, "workspace");
    stateDir = path.join(tmpRoot, "state");
    // Only workspace must exist for configured collection paths; state paths are
    // created lazily by manager code when needed.
    await fs.mkdir(workspaceDir, { recursive: true });
    setQmdStateDir(stateDir);
    // Keep the default Windows path unresolved for most tests so spawn mocks can
    // match the logical package command. Tests that verify wrapper resolution
    // install explicit shim fixtures inline.
    cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            rememberAcrossConversations: false,
            store: { vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: false },
          },
        },
        list: [{ id: agentId, default: true, workspace: workspaceDir }],
      },
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    seedMemoryEmbeddingProviders();
    embedStartupJitterSpy = vi
      .spyOn(
        QmdMemoryManager.prototype as unknown as {
          resolveEmbedStartupJitterMs: () => number;
        },
        "resolveEmbedStartupJitterMs",
      )
      .mockReturnValue(0);
  });

  afterEach(async () => {
    await Promise.all(
      Array.from(openManagers, async (manager) => {
        await manager.close();
      }),
    );
    openManagers.clear();
    embedStartupJitterSpy?.mockRestore();
    embedStartupJitterSpy = null;
    vi.useRealTimers();
    restoreQmdStateDir();
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalPathExt === undefined) {
      delete process.env.PATHEXT;
    } else {
      process.env.PATHEXT = originalPathExt;
    }
    if (originalWindowsPath === undefined) {
      delete process.env.Path;
    } else {
      process.env.Path = originalWindowsPath;
    }
    delete (globalThis as Record<PropertyKey, unknown>)[MCPORTER_STATE_KEY];
    delete (globalThis as Record<PropertyKey, unknown>)[QMD_EMBED_QUEUE_KEY];
    delete (globalThis as Record<PropertyKey, unknown>)[MEMORY_EMBEDDING_PROVIDERS_KEY];
    resetMemoryCoreDreamingStateForTests();
    closeOpenClawAgentDatabasesForTest();
  });

  it("debounces back-to-back sync calls", async () => {
    const { manager, resolved } = await createManager();

    const baselineCalls = spawnMock.mock.calls.length;

    await manager.sync({ reason: "manual" });
    expect(spawnMock.mock.calls.length).toBe(baselineCalls + 1);

    await manager.sync({ reason: "manual-again" });
    expect(spawnMock.mock.calls.length).toBe(baselineCalls + 1);

    (manager as unknown as { lastUpdateAt: number | null }).lastUpdateAt =
      Date.now() - (resolved.qmd?.update.debounceMs ?? 0) - 10;

    await manager.sync({ reason: "after-wait" });
    expect(spawnMock.mock.calls.length).toBe(baselineCalls + 2);

    await manager.close();
  });

  it("runs a qmd sync once for the first search in a fresh session", async () => {
    cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { vector: { enabled: false } },
            sync: { watch: false, onSessionStart: true, onSearch: false },
          },
        },
        list: [{ id: agentId, default: true, workspace: workspaceDir }],
      },
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (args[0] === "search" || args[0] === "query" || args[0] === "vsearch") {
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      queueMicrotask(() => child.closeWith(0));
      return child;
    });

    const { manager } = await createManager({ mode: "full" });

    await manager.search("hello", { sessionKey: "session-a" });
    await manager.search("hello again", { sessionKey: "session-a" });

    const updateCalls = spawnMock.mock.calls.filter((call) => call[1]?.[0] === "update");
    expect(updateCalls).toHaveLength(1);
  });

  it("does not block first search on session-start sync completion", async () => {
    vi.useFakeTimers();
    cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { vector: { enabled: false } },
            sync: { watch: false, onSessionStart: true, onSearch: false },
          },
        },
        list: [{ id: agentId, default: true, workspace: workspaceDir }],
      },
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    let releaseUpdate: (() => void) | null = null;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        const child = createMockChild({ autoClose: false });
        releaseUpdate = () => child.closeWith(0);
        return child;
      }
      if (args[0] === "search" || args[0] === "query" || args[0] === "vsearch") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    const searchPromise = manager.search("hello", { sessionKey: "session-b" });

    await vi.advanceTimersByTimeAsync(500);
    await expect(searchPromise).resolves.toStrictEqual([]);

    (
      releaseUpdate ??
      (() => {
        throw new Error("expected qmd update process to start");
      })
    )();
    await manager.close();
  });

  it("runs qmd sync when watched collection files change", async () => {
    vi.useFakeTimers();
    cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { vector: { enabled: false } },
            sync: { watch: true, onSessionStart: false, onSearch: false },
          },
        },
        list: [{ id: agentId, default: true, workspace: workspaceDir }],
      },
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const { manager } = await createManager({ mode: "full" });
    expect(watchMock).toHaveBeenCalledTimes(1);
    const watcher = watchMock.mock.results[0]?.value as EventEmitter & {
      watchedEntries: Record<string, string[]>;
    };
    const initialUpdateCalls = spawnMock.mock.calls.filter((call) => call[1]?.[0] === "update");
    expect(initialUpdateCalls).toHaveLength(0);
    const watchOptions = firstWatchOptions();
    expect(watchOptions).not.toHaveProperty("awaitWriteFinish");
    expect(watchOptions.ignored?.(path.join(workspaceDir, "node_modules", "pkg", "note.md"))).toBe(
      true,
    );
    expect(watchOptions.ignored?.(path.join(workspaceDir, ".cache", "qmd", "note.md"))).toBe(true);
    expect(watchOptions.ignored?.(path.join(workspaceDir, "vendor", "pkg", "note.md"))).toBe(true);
    expect(watchOptions.ignored?.(path.join(workspaceDir, "dist", "note.md"))).toBe(true);
    expect(watchOptions.ignored?.(path.join(workspaceDir, "build", "note.md"))).toBe(true);
    expect(watchOptions.ignored?.(path.join(workspaceDir, "notes.md"))).toBe(false);
    watcher.watchedEntries = {
      [workspaceDir]: Array.from({ length: 2_001 }, (_value, index) => `${index}.md`),
    };
    watcher.emit("ready");
    expectMockMessageContains(logWarnMock, "Memory file watching is tracking 2002 paths.");

    const notesPath = path.join(workspaceDir, "notes.md");
    await fs.writeFile(notesPath, "hello");
    const initialStats = await fs.stat(notesPath);
    watcher.emit("change", notesPath, {
      size: initialStats.size,
      mtimeMs: initialStats.mtimeMs,
      isDirectory: () => false,
    });
    expect(manager.status().dirty).toBe(true);

    await vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS);

    const updateCalls = spawnMock.mock.calls.filter((call) => call[1]?.[0] === "update");
    expect(updateCalls).toHaveLength(1);
    expect(manager.status().dirty).toBe(false);

    await manager.close();
  });

  it("keeps explicit qmd collection roots watchable when their directory name is ignored", async () => {
    const rootNames = ["build", "dist", "vendor", ".cache"];
    const roots = rootNames.map((name) => path.join(workspaceDir, name));
    cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { vector: { enabled: false } },
            sync: { watch: true, onSessionStart: false, onSearch: false },
          },
        },
        list: [{ id: agentId, default: true, workspace: workspaceDir }],
      },
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          paths: roots.map((root) => ({
            path: root,
            pattern: "**/*.md",
            name: path.basename(root),
          })),
        },
      },
    } as OpenClawConfig;

    const { manager } = await createManager({ mode: "full" });
    expect(watchMock).toHaveBeenCalledTimes(1);
    expect(firstWatchPaths().toSorted()).toEqual(
      roots.map((root) => path.join(root, "**/*.md")).toSorted(),
    );
    const ignored = firstWatchOptions().ignored;
    for (const root of roots) {
      expect(ignored?.(root)).toBe(false);
      expect(ignored?.(path.join(root, "note.md"))).toBe(false);
      expect(ignored?.(path.join(root, "..notes", "daily.md"))).toBe(false);
      expect(ignored?.(path.join(root, "notes", "daily.md"))).toBe(false);
      expect(ignored?.(path.join(root, "node_modules", "pkg", "note.md"))).toBe(true);
      expect(ignored?.(path.join(root, "build", "artifact.md"))).toBe(true);
    }

    await manager.close();
  });

  it("prefers a nested explicit qmd collection root over a broader watched root", async () => {
    const nestedRoot = path.join(workspaceDir, "build");
    cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { vector: { enabled: false } },
            sync: { watch: true, onSessionStart: false, onSearch: false },
          },
        },
        list: [{ id: agentId, default: true, workspace: workspaceDir }],
      },
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          paths: [
            { path: workspaceDir, pattern: "**/*.md", name: "workspace" },
            { path: nestedRoot, pattern: "**/*.md", name: "build" },
          ],
        },
      },
    } as OpenClawConfig;

    const { manager } = await createManager({ mode: "full" });
    const ignored = firstWatchOptions().ignored;
    expect(ignored?.(path.join(nestedRoot, "note.md"))).toBe(false);
    expect(ignored?.(path.join(nestedRoot, "..notes", "daily.md"))).toBe(false);
    expect(ignored?.(path.join(nestedRoot, "node_modules", "pkg", "note.md"))).toBe(true);
    expect(ignored?.(path.join(workspaceDir, "node_modules", "pkg", "note.md"))).toBe(true);

    await manager.close();
  });

  it("delays qmd watch sync until changed file stats settle", async () => {
    vi.useFakeTimers();
    cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { vector: { enabled: false } },
            sync: { watch: true, onSessionStart: false, onSearch: false },
          },
        },
        list: [{ id: agentId, default: true, workspace: workspaceDir }],
      },
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const notesPath = path.join(workspaceDir, "notes.md");
    await fs.writeFile(notesPath, "hello");
    const initialStats = await fs.stat(notesPath);
    const { manager } = await createManager({ mode: "full" });
    const watcher = watchMock.mock.results[0]?.value as {
      emit: (event: string, ...args: unknown[]) => boolean;
    };

    watcher.emit("change", notesPath, {
      size: initialStats.size,
      mtimeMs: initialStats.mtimeMs,
      isDirectory: () => false,
    });
    await fs.writeFile(notesPath, "hello updated");

    await vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS);
    expect(spawnMock.mock.calls.filter((call) => call[1]?.[0] === "update")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS);
    expect(spawnMock.mock.calls.filter((call) => call[1]?.[0] === "update")).toHaveLength(1);

    await manager.close();
  });

  it("runs boot update in background by default", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: true },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    let releaseUpdate: (() => void) | null = null;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        const child = createMockChild({ autoClose: false });
        releaseUpdate = () => child.closeWith(0);
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    (
      releaseUpdate ??
      (() => {
        throw new Error("Expected qmd update release callback");
      })
    )();
    await manager?.close();
  });

  it("skips qmd command side effects in status mode initialization", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "5m", debounceMs: 60_000, onBoot: true },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const { manager } = await createManager({ mode: "status" });
    expect(spawnMock).not.toHaveBeenCalled();
    await manager?.close();
  });

  it("initializes one-shot CLI mode without watchers or background updates", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "5m", debounceMs: 60_000, onBoot: true },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const { manager } = await createManager({ mode: "cli" });

    expect(watchMock).not.toHaveBeenCalled();
    const updateCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "update" || args[0] === "embed");
    expect(updateCalls).toStrictEqual([]);

    await manager?.close();
  });

  it("preserves blocking boot update freshness for one-shot CLI mode", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: {
            interval: "5m",
            debounceMs: 60_000,
            onBoot: true,
            waitForBootSync: true,
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const updateSpawned = createDeferred<void>();
    let releaseUpdate: (() => void) | null = null;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        const child = createMockChild({ autoClose: false });
        releaseUpdate = () => child.closeWith(0);
        updateSpawned.resolve();
        return child;
      }
      return createMockChild();
    });

    const createPromise = createManager({ mode: "cli" });
    await updateSpawned.promise;
    let created = false;
    void createPromise.then(() => {
      created = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(created).toBe(false);
    expect(watchMock).not.toHaveBeenCalled();

    (releaseUpdate as (() => void) | null)?.();
    const { manager } = await createPromise;
    const updateCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "update" || args[0] === "embed");
    expect(updateCalls).toStrictEqual([["update"]]);
    expect(watchMock).not.toHaveBeenCalled();

    await manager?.close();
  });

  it("keeps one-shot CLI searches from scheduling session-start updates", async () => {
    cfg = {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          workspace: workspaceDir,
          memorySearch: {
            ...cfg.agents?.defaults?.memorySearch,
            sync: { watch: false, onSessionStart: true, onSearch: true },
          },
        },
      },
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "cli" });

    await expect(
      manager.search("glacier", { sessionKey: "agent:main:cli:memory-search" }),
    ).resolves.toStrictEqual([]);
    await manager.close();

    const updateCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "update" || args[0] === "embed");
    expect(updateCalls).toStrictEqual([]);
    expect(
      spawnMock.mock.calls.some((call: unknown[]) => (call[1] as string[])?.[0] === "search"),
    ).toBe(true);
  });

  it("can be configured to block startup on boot update", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: {
            interval: "0s",
            debounceMs: 60_000,
            onBoot: true,
            waitForBootSync: true,
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const updateSpawned = createDeferred<void>();
    let releaseUpdate: (() => void) | null = null;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        const child = createMockChild({ autoClose: false });
        releaseUpdate = () => child.closeWith(0);
        updateSpawned.resolve();
        return child;
      }
      return createMockChild();
    });

    const resolved = resolveMemoryBackendConfig({ cfg, agentId });
    const createPromise = QmdMemoryManager.create({
      cfg,
      agentId,
      resolved,
      withLease: withLeaseMock,
      mode: "full",
    });
    await updateSpawned.promise;
    let created = false;
    void createPromise.then(() => {
      created = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(created).toBe(false);
    (releaseUpdate as (() => void) | null)?.();
    const manager = await createPromise;
    await manager?.close();
  });

  it("times out collection bootstrap commands", async () => {
    vi.useFakeTimers();
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: {
            interval: "0s",
            debounceMs: 60_000,
            onBoot: false,
            commandTimeoutMs: 15,
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        return createMockChild({ autoClose: false });
      }
      return createMockChild();
    });

    const managerPromise = createManager({ mode: "full" });
    await waitUntil(() =>
      spawnMock.mock.calls.some((call: unknown[]) => {
        const args = call[1] as string[];
        return args[0] === "collection" && args[1] === "list";
      }),
    );
    await vi.advanceTimersByTimeAsync(15);
    const { manager } = await managerPromise;
    const status = manager.status();
    expect(status.backend).toBe("qmd");
    expect(status.requestedProvider).toBe("qmd");
    await manager?.close();
  });

  it("rebinds sessions collection when existing collection path targets another agent", async () => {
    const devAgentId = "dev";
    const devWorkspaceDir = path.join(tmpRoot, "workspace-dev");
    await fs.mkdir(devWorkspaceDir);
    cfg = {
      ...cfg,
      agents: {
        list: [
          { id: agentId, default: true, workspace: workspaceDir },
          { id: devAgentId, workspace: devWorkspaceDir },
        ],
      },
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: devWorkspaceDir, pattern: "**/*.md", name: "workspace" }],
          sessions: { enabled: true },
        },
      },
    } as OpenClawConfig;

    const sessionCollectionName = `sessions-${devAgentId}`;
    const wrongSessionsPath = path.join(stateDir, "agents", agentId, "qmd", "sessions");
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([
            { name: sessionCollectionName, path: wrongSessionsPath, mask: "**/*.md" },
          ]),
        );
        return child;
      }
      return createMockChild();
    });

    const resolved = resolveMemoryBackendConfig({ cfg, agentId: devAgentId });
    const manager = trackManager(
      await QmdMemoryManager.create({
        cfg,
        agentId: devAgentId,
        resolved,
        withLease: withLeaseMock,
        mode: "full",
      }),
    );
    await requireValue(manager, "manager missing").close();

    const commands = spawnMock.mock.calls.map((call: unknown[]) => call[1] as string[]);
    const removeSessions = commands.find(
      (args) =>
        args[0] === "collection" && args[1] === "remove" && args[2] === sessionCollectionName,
    );
    requireValue(removeSessions, "sessions collection remove command missing");

    const addSessions = commands.find((args) => {
      if (args[0] !== "collection" || args[1] !== "add") {
        return false;
      }
      const nameIdx = args.indexOf("--name");
      return nameIdx >= 0 && args[nameIdx + 1] === sessionCollectionName;
    });
    expect(requireValue(addSessions, "sessions collection add command missing")[2]).toBe(
      path.join(stateDir, "agents", devAgentId, "qmd", "sessions"),
    );
  });

  it("avoids destructive rebind when qmd only reports collection names", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          sessions: { enabled: true },
        },
      },
    } as OpenClawConfig;

    const sessionCollectionName = `sessions-${agentId}`;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([`workspace-${agentId}`, sessionCollectionName]),
        );
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    const commands = spawnMock.mock.calls.map((call: unknown[]) => call[1] as string[]);
    const removeCalls = commands.filter((args) => args[0] === "collection" && args[1] === "remove");
    expect(removeCalls).toHaveLength(0);

    const addCalls = commands.filter((args) => args[0] === "collection" && args[1] === "add");
    expect(addCalls).toHaveLength(0);
  });

  it("rebinds collection when qmd text output exposes a changed pattern without a path", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          ["workspace-main (qmd://workspace-main/)", "  Pattern:  *.txt", "  Files:    17"].join(
            "\n",
          ),
        );
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    const commands = spawnMock.mock.calls.map((call: unknown[]) => call[1] as string[]);
    const removeCalls = commands.filter(
      (args) => args[0] === "collection" && args[1] === "remove" && args[2] === "workspace-main",
    );
    expect(removeCalls).toHaveLength(1);

    const addCall = commands.find((args) => {
      if (args[0] !== "collection" || args[1] !== "add") {
        return false;
      }
      const nameIdx = args.indexOf("--name");
      return nameIdx >= 0 && args[nameIdx + 1] === "workspace-main";
    });
    const workspaceAddCall = requireValue(addCall, "workspace collection add command missing");
    expect(workspaceAddCall[2]).toBe(workspaceDir);
    expect(workspaceAddCall).toContain("**/*.md");
  });

  it("migrates unscoped legacy collections before adding scoped names", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    const legacyCollections = new Map<
      string,
      {
        path: string;
        pattern: string;
      }
    >([
      ["memory-root", { path: workspaceDir, pattern: "MEMORY.md" }],
      ["memory-dir", { path: path.join(workspaceDir, "memory"), pattern: "**/*.md" }],
    ]);
    const removeCalls: string[] = [];

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify(
            [...legacyCollections.entries()].map(([name, info]) => ({
              name,
              path: info.path,
              mask: info.pattern,
            })),
          ),
        );
        return child;
      }
      if (args[0] === "collection" && args[1] === "remove") {
        const child = createMockChild({ autoClose: false });
        const name = args[2] ?? "";
        removeCalls.push(name);
        legacyCollections.delete(name);
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      if (args[0] === "collection" && args[1] === "add") {
        const child = createMockChild({ autoClose: false });
        const pathArg = args[2] ?? "";
        const name = args[args.indexOf("--name") + 1] ?? "";
        const globIdx = args.indexOf("--glob");
        const maskIdx = args.indexOf("--mask");
        const pattern =
          (globIdx !== -1 ? args[globIdx + 1] : maskIdx !== -1 ? args[maskIdx + 1] : "") ?? "";
        const hasConflict = [...legacyCollections.entries()].some(
          ([existingName, info]) =>
            existingName !== name && info.path === pathArg && info.pattern === pattern,
        );
        if (hasConflict) {
          emitAndClose(child, "stderr", "collection already exists", 1);
          return child;
        }
        legacyCollections.set(name, { path: pathArg, pattern });
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    expect(removeCalls).toEqual(["memory-root", "memory-dir"]);
    expect(legacyCollections.has("memory-root-main")).toBe(true);
    expect(legacyCollections.has("memory-dir-main")).toBe(true);
    expect(legacyCollections.has("memory-root")).toBe(false);
    expect(legacyCollections.has("memory-dir")).toBe(false);
    expect(legacyCollections.has("memory-alt-main")).toBe(false);
    expect(legacyCollections.has("memory-alt")).toBe(false);
  });

  it("rebinds conflicting collection name when path+pattern slot is already occupied", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    const listedCollections = new Map<
      string,
      {
        path: string;
        pattern: string;
      }
    >([["memory-root-sonnet", { path: workspaceDir, pattern: "MEMORY.md" }]]);
    const removeCalls: string[] = [];

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify(
            [...listedCollections.entries()].map(([name, info]) => ({
              name,
              path: info.path,
              mask: info.pattern,
            })),
          ),
        );
        return child;
      }
      if (args[0] === "collection" && args[1] === "remove") {
        const child = createMockChild({ autoClose: false });
        const name = args[2] ?? "";
        removeCalls.push(name);
        listedCollections.delete(name);
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      if (args[0] === "collection" && args[1] === "add") {
        const child = createMockChild({ autoClose: false });
        const pathArg = args[2] ?? "";
        const name = args[args.indexOf("--name") + 1] ?? "";
        const globIdx = args.indexOf("--glob");
        const maskIdx = args.indexOf("--mask");
        const pattern =
          (globIdx !== -1 ? args[globIdx + 1] : maskIdx !== -1 ? args[maskIdx + 1] : "") ?? "";
        const hasConflict = [...listedCollections.entries()].some(
          ([existingName, info]) =>
            existingName !== name && info.path === pathArg && info.pattern === pattern,
        );
        if (hasConflict) {
          emitAndClose(child, "stderr", "A collection already exists for this path and pattern", 1);
          return child;
        }
        listedCollections.set(name, { path: pathArg, pattern });
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    expect(removeCalls).toContain("memory-root-sonnet");
    expect(listedCollections.has("memory-root-main")).toBe(true);
    expectMockMessageContains(logWarnMock, "rebinding");
  });

  it("adds canonical memory-root without treating legacy memory-alt as equivalent", async () => {
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# canonical root");
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    const listedCollections = new Map<
      string,
      {
        path: string;
        pattern: string;
      }
    >([["memory-alt", { path: workspaceDir, pattern: "memory.md" }]]);
    const removeCalls: string[] = [];

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify(
            [...listedCollections.entries()].map(([name, info]) => ({
              name,
              path: info.path,
              mask: info.pattern,
            })),
          ),
        );
        return child;
      }
      if (args[0] === "collection" && args[1] === "remove") {
        const child = createMockChild({ autoClose: false });
        const name = args[2] ?? "";
        removeCalls.push(name);
        listedCollections.delete(name);
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      if (args[0] === "collection" && args[1] === "add") {
        const child = createMockChild({ autoClose: false });
        const pathArg = args[2] ?? "";
        const name = args[args.indexOf("--name") + 1] ?? "";
        const patternIndex = args.includes("--glob")
          ? args.indexOf("--glob") + 1
          : args.includes("--mask")
            ? args.indexOf("--mask") + 1
            : -1;
        const pattern = patternIndex >= 0 ? (args[patternIndex] ?? "") : "";
        const hasConflict = [...listedCollections.entries()].some(
          ([existingName, info]) =>
            existingName !== name && info.path === pathArg && info.pattern === pattern,
        );
        if (hasConflict) {
          emitAndClose(child, "stderr", "A collection already exists for this path and pattern", 1);
          return child;
        }
        listedCollections.set(name, { path: pathArg, pattern });
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    expect(removeCalls).not.toContain("memory-alt");
    expect(listedCollections.has("memory-root-main")).toBe(true);
    expect(listedCollections.has("memory-alt")).toBe(true);
    expectMockMessageNotContains(logWarnMock, "rebinding");
  });

  it("warns instead of silently succeeding when add conflict metadata is unavailable", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        // Name-only rows do not expose path/mask metadata.
        emitAndClose(child, "stdout", JSON.stringify(["workspace-legacy"]));
        return child;
      }
      if (args[0] === "collection" && args[1] === "add") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stderr", "collection already exists", 1);
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    expectMockMessageContains(logWarnMock, "qmd collection add skipped for workspace-main");
  });

  it("surfaces a manual repair hint for stderr-only path-pattern conflicts", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    let staleCollectionExists = true;
    const removeCalls: string[] = [];
    const addCalls: string[] = [];

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        // Older qmd output may expose only names, so path/pattern matching cannot find this.
        emitAndClose(child, "stdout", JSON.stringify(["workspace-legacy"]));
        return child;
      }
      if (args[0] === "collection" && args[1] === "remove") {
        const child = createMockChild({ autoClose: false });
        const name = args[2] ?? "";
        removeCalls.push(name);
        if (name === "workspace-legacy") {
          staleCollectionExists = false;
        }
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      if (args[0] === "collection" && args[1] === "add") {
        const child = createMockChild({ autoClose: false });
        const name = args[args.indexOf("--name") + 1] ?? "";
        addCalls.push(name);
        if (staleCollectionExists && name === "workspace-main") {
          emitAndClose(
            child,
            "stderr",
            [
              "A collection already exists for this path and pattern:",
              "  Name: workspace-legacy (qmd://workspace-legacy/)",
              "  Pattern: **/*.md",
              "",
              "Use 'qmd update' to re-index it, or remove it first with 'qmd collection remove workspace-legacy'",
            ].join("\n"),
            1,
          );
          return child;
        }
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    expect(removeCalls).toEqual([]);
    expect(addCalls).toEqual(["workspace-main"]);
    expectMockMessageNotContains(logWarnMock, "rebinding");
    expectMockMessageContains(
      logWarnMock,
      "qmd reported existing collection workspace-legacy, but list output did not include verifiable path/pattern metadata",
    );
    expectMockMessageContains(logWarnMock, "qmd collection remove workspace-legacy");
    expectMockMessageContains(logWarnMock, "qmd collection add skipped for workspace-main");
  });

  it("recreates a managed collection when list fails but add reports the same name exists", async () => {
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# canonical root");
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    const removed: string[] = [];
    const added = new Map<string, string>();
    const addAttempts = new Map<string, number>();
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stderr", "temporary qmd list failure", 1);
        return child;
      }
      if (args[0] === "collection" && args[1] === "remove") {
        const child = createMockChild({ autoClose: false });
        const name = args[2] ?? "";
        removed.push(name);
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      if (args[0] === "collection" && args[1] === "add") {
        const child = createMockChild({ autoClose: false });
        const name = args[args.indexOf("--name") + 1] ?? "";
        const patternIndex = args.includes("--glob")
          ? args.indexOf("--glob") + 1
          : args.includes("--mask")
            ? args.indexOf("--mask") + 1
            : -1;
        const pattern = patternIndex >= 0 ? (args[patternIndex] ?? "") : "";
        const attempts = addAttempts.get(name) ?? 0;
        addAttempts.set(name, attempts + 1);
        if (name === "memory-root-main" && attempts === 0) {
          emitAndClose(child, "stderr", "Collection 'memory-root-main' already exists.", 1);
          return child;
        }
        added.set(name, pattern);
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    expect(removed).toContain("memory-root-main");
    expect(added.get("memory-root-main")).toBe("MEMORY.md");
    expectMockMessageContains(
      logWarnMock,
      "qmd collection add conflict for memory-root-main: collection name already exists",
    );
    expectMockMessageNotContains(logWarnMock, "qmd collection add skipped for memory-root-main");
  });

  it("rebinds memory-root when qmd table output has a stale broad pattern", async () => {
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# canonical root");
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    const removed: string[] = [];
    const added = new Map<string, string>();
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          [
            "Collections (2):",
            "",
            "memory-dir-main (qmd://memory-dir-main/)",
            "  Pattern:  **/*.md",
            "",
            "memory-root-main (qmd://memory-root-main/)",
            "  Pattern:  **/*.md",
            "",
          ].join("\n"),
        );
        return child;
      }
      if (args[0] === "collection" && args[1] === "remove") {
        const child = createMockChild({ autoClose: false });
        const name = args[2] ?? "";
        removed.push(name);
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      if (args[0] === "collection" && args[1] === "add") {
        const child = createMockChild({ autoClose: false });
        const name = args[args.indexOf("--name") + 1] ?? "";
        const patternIndex = args.includes("--glob")
          ? args.indexOf("--glob") + 1
          : args.includes("--mask")
            ? args.indexOf("--mask") + 1
            : -1;
        const pattern = patternIndex >= 0 ? (args[patternIndex] ?? "") : "";
        added.set(name, pattern);
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    expect(removed).toContain("memory-root-main");
    expect(added.get("memory-root-main")).toBe("MEMORY.md");
    expect(removed).not.toContain("memory-dir-main");
  });

  it("falls back to --glob when qmd collection add rejects --mask", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    const addFlagCalls: string[] = [];
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      if (args[0] === "collection" && args[1] === "add") {
        const child = createMockChild({ autoClose: false });
        const flag = args.includes("--glob") ? "--glob" : args.includes("--mask") ? "--mask" : "";
        addFlagCalls.push(flag);
        if (flag === "--mask") {
          emitAndClose(child, "stderr", "unknown flag: --mask", 1);
          return child;
        }
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    expect(addFlagCalls).toEqual(["--mask", "--glob", "--glob"]);
    expectMockMessageContains(logWarnMock, "retrying with legacy compatibility flag");
  });
  it("migrates unscoped legacy collections from plain-text collection list output", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    const removeCalls: string[] = [];
    const addCalls: string[] = [];
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          [
            "Collections (2):",
            "",
            "memory-root (qmd://memory-root/)",
            "  Pattern:  MEMORY.md",
            "",
            "memory-dir (qmd://memory-dir/)",
            "  Pattern:  **/*.md",
            "",
          ].join("\n"),
        );
        return child;
      }
      if (args[0] === "collection" && args[1] === "remove") {
        const child = createMockChild({ autoClose: false });
        removeCalls.push(args[2] ?? "");
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      if (args[0] === "collection" && args[1] === "add") {
        const child = createMockChild({ autoClose: false });
        addCalls.push(args[args.indexOf("--name") + 1] ?? "");
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    expect(removeCalls).toEqual(["memory-root", "memory-dir"]);
    expect(addCalls).toEqual(["memory-root-main", "memory-dir-main"]);
  });

  it("does not migrate unscoped collections when listed metadata differs", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    const differentPath = path.join(tmpRoot, "other-memory");
    await fs.mkdir(differentPath, { recursive: true });
    const removeCalls: string[] = [];
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([{ name: "memory-root", path: differentPath, mask: "MEMORY.md" }]),
        );
        return child;
      }
      if (args[0] === "collection" && args[1] === "remove") {
        const child = createMockChild({ autoClose: false });
        removeCalls.push(args[2] ?? "");
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    expect(removeCalls).not.toContain("memory-root");
    expectMockMessageContains(
      logDebugMock,
      "qmd legacy collection migration skipped for memory-root",
    );
  });

  it("times out qmd update during sync when configured", async () => {
    vi.useFakeTimers();
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: {
            interval: "0s",
            debounceMs: 0,
            onBoot: false,
            updateTimeoutMs: 20,
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        return createMockChild({ autoClose: false });
      }
      return createMockChild();
    });

    const resolved = resolveMemoryBackendConfig({ cfg, agentId });
    const createPromise = QmdMemoryManager.create({
      cfg,
      agentId,
      resolved,
      withLease: withLeaseMock,
      mode: "status",
    });
    await vi.advanceTimersByTimeAsync(0);
    const manager = requireValue(trackManager(await createPromise), "manager missing");
    const syncPromise = manager.sync({ reason: "manual" });
    const rejected = expect(syncPromise).rejects.toThrow("qmd update timed out after 20ms");
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    await manager.close();
  });

  it("rebuilds managed collections once when qmd update fails with null-byte ENOTDIR", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    let updateCalls = 0;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        updateCalls += 1;
        const child = createMockChild({ autoClose: false });
        if (updateCalls === 1) {
          emitAndClose(
            child,
            "stderr",
            "ENOTDIR: not a directory, open '/tmp/workspace/MEMORY.md^@'",
            1,
          );
          return child;
        }
        queueMicrotask(() => {
          child.closeWith(0);
        });
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "status" });
    await expect(manager.sync({ reason: "manual" })).resolves.toBeUndefined();

    const removeCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "collection" && args[1] === "remove")
      .map((args) => args[2]);
    const addCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "collection" && args[1] === "add")
      .map((args) => args[args.indexOf("--name") + 1]);

    expect(updateCalls).toBe(2);
    expect(removeCalls).toEqual(["memory-root-main", "memory-dir-main"]);
    expect(addCalls).toEqual(["memory-root-main", "memory-dir-main"]);
    expectMockMessageContains(logWarnMock, "suspected null-byte collection metadata");

    await manager.close();
  });

  it("rebuilds managed collections once when qmd update fails with null-byte ENOENT", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    let updateCalls = 0;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        updateCalls += 1;
        const child = createMockChild({ autoClose: false });
        if (updateCalls === 1) {
          emitAndClose(
            child,
            "stderr",
            "ENOENT: no such file or directory, open '/tmp/workspace/MEMORY.md\\x00'",
            1,
          );
          return child;
        }
        queueMicrotask(() => {
          child.closeWith(0);
        });
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "status" });
    await expect(manager.sync({ reason: "manual" })).resolves.toBeUndefined();

    const removeCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "collection" && args[1] === "remove")
      .map((args) => args[2]);
    const addCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "collection" && args[1] === "add")
      .map((args) => args[args.indexOf("--name") + 1]);

    expect(updateCalls).toBe(2);
    expect(removeCalls).toEqual(["memory-root-main", "memory-dir-main"]);
    expect(addCalls).toEqual(["memory-root-main", "memory-dir-main"]);
    expectMockMessageContains(logWarnMock, "suspected null-byte collection metadata");

    await manager.close();
  });

  it("rebuilds managed collections once when qmd update hits duplicate document constraint", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    let updateCalls = 0;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        updateCalls += 1;
        const child = createMockChild({ autoClose: false });
        if (updateCalls === 1) {
          emitAndClose(
            child,
            "stderr",
            "SQLiteError: UNIQUE constraint failed: documents.collection, documents.path",
            1,
          );
          return child;
        }
        queueMicrotask(() => {
          child.closeWith(0);
        });
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "status" });
    await expect(manager.sync({ reason: "manual" })).resolves.toBeUndefined();

    const removeCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "collection" && args[1] === "remove")
      .map((args) => args[2]);
    const addCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "collection" && args[1] === "add")
      .map((args) => args[args.indexOf("--name") + 1]);

    expect(updateCalls).toBe(2);
    expect(removeCalls).toEqual(["memory-root-main", "memory-dir-main"]);
    expect(addCalls).toEqual(["memory-root-main", "memory-dir-main"]);
    expectMockMessageContains(logWarnMock, "duplicate document constraint");

    await manager.close();
  });

  it("refreshes qmd index config with quoted collection values during update repair", async () => {
    const notesDir = path.join(workspaceDir, "Notes #1: blue");
    await fs.mkdir(notesDir, { recursive: true });
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          paths: [{ path: notesDir, pattern: "**/* #tag: [draft].md", name: "notes" }],
        },
      },
    } as OpenClawConfig;

    let updateCalls = 0;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        updateCalls += 1;
        const child = createMockChild({ autoClose: false });
        if (updateCalls === 1) {
          emitAndClose(
            child,
            "stderr",
            "SQLiteError: UNIQUE constraint failed: documents.collection, documents.path",
            1,
          );
          return child;
        }
        queueMicrotask(() => {
          child.closeWith(0);
        });
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "status" });
    await expect(manager.sync({ reason: "manual" })).resolves.toBeUndefined();

    const indexConfig = await fs.readFile(qmdIndexConfigPath(), "utf8");
    expect(indexConfig).toContain('  "notes-main":');
    expect(indexConfig).toContain(`    path: ${JSON.stringify(notesDir)}`);
    expect(indexConfig).toContain('    pattern: "**/* #tag: [draft].md"');
    expect(updateCalls).toBe(2);

    await manager.close();
  });

  it("forces repair remove/add even when managed collections are still listed", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    let updateCalls = 0;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([
            { name: "memory-root-main", path: workspaceDir, mask: "MEMORY.md" },
            { name: "memory-dir-main", path: path.join(workspaceDir, "memory"), mask: "**/*.md" },
          ]),
        );
        return child;
      }
      if (args[0] === "update") {
        updateCalls += 1;
        const child = createMockChild({ autoClose: false });
        if (updateCalls === 1) {
          emitAndClose(
            child,
            "stderr",
            "SQLiteError: UNIQUE constraint failed: documents.collection, documents.path",
            1,
          );
          return child;
        }
        queueMicrotask(() => {
          child.closeWith(0);
        });
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await expect(manager.sync({ reason: "manual" })).resolves.toBeUndefined();

    const removeCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "collection" && args[1] === "remove")
      .map((args) => args[2]);
    const addCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "collection" && args[1] === "add")
      .map((args) => args[args.indexOf("--name") + 1]);

    expect(updateCalls).toBe(2);
    expect(removeCalls).toEqual(["memory-root-main", "memory-dir-main"]);
    expect(addCalls).toEqual(["memory-root-main", "memory-dir-main"]);

    await manager.close();
  });

  it("does not rebuild collections for unrelated unique constraint failures", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stderr", "SQLiteError: UNIQUE constraint failed: documents.docid", 1);
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "status" });
    await expect(manager.sync({ reason: "manual" })).rejects.toThrow(
      "SQLiteError: UNIQUE constraint failed: documents.docid",
    );

    const removeCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "collection" && args[1] === "remove");
    expect(removeCalls).toHaveLength(0);

    await manager.close();
  });

  it("does not rebuild collections for generic qmd update failures", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stderr",
          "ENOTDIR: not a directory, open '/tmp/workspace/MEMORY.md'",
          1,
        );
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "status" });
    await expect(manager.sync({ reason: "manual" })).rejects.toThrow(
      "ENOTDIR: not a directory, open '/tmp/workspace/MEMORY.md'",
    );

    const removeCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "collection" && args[1] === "remove");
    expect(removeCalls).toHaveLength(0);

    await manager.close();
  });

  it("uses configured qmd search mode command", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager, resolved } = await createManager();
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }

    await expect(
      manager.search("test", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toStrictEqual([]);

    const searchCall = spawnMock.mock.calls.find(
      (call: unknown[]) => (call[1] as string[])?.[0] === "search",
    );
    expect(searchCall?.[1]).toEqual([
      "search",
      "test",
      "--json",
      "-n",
      String(resolved.qmd?.limits.maxResults),
      "-c",
      "workspace-main",
    ]);
    expect(
      spawnMock.mock.calls.some((call: unknown[]) => (call[1] as string[])?.[0] === "query"),
    ).toBe(false);
    expect(maxResults).toBeGreaterThan(0);
    await manager.close();
  });

  it("uses valid qmd query JSON captured before a non-zero exit", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "query") {
        const child = createMockChild({ autoClose: false });
        queueMicrotask(() => {
          child.stdout.emit("data", "initializing qmd reranker\n");
          child.stdout.emit(
            "data",
            JSON.stringify(
              [
                {
                  file: "qmd://workspace-main/notes/welcome.md",
                  score: 0.93,
                  snippet: "@@ -7,1\nrouter glacier backup",
                },
              ],
              null,
              2,
            ),
          );
          child.stderr.emit("data", "ggml-metal-device.m:612 assertion failed");
          child.closeWith(134);
        });
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    await expect(
      manager.search("router glacier backup", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([
      {
        path: "notes/welcome.md",
        startLine: 7,
        endLine: 7,
        score: 0.93,
        snippet: "@@ -7,1\nrouter glacier backup",
        source: "memory",
      },
    ]);
    expectMockMessageContains(
      logWarnMock,
      "qmd query exited non-zero after producing valid JSON; using captured search results (code 134)",
    );
    await manager.close();
  });

  it("keeps invalid qmd query stdout failed after a non-zero exit", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "query") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "not json", 134);
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    await expect(
      manager.search("router glacier backup", { sessionKey: "agent:main:slack:dm:u123" }),
    ).rejects.toThrow(/qmd query router glacier backup .* failed \(code 134\): not json/);
    await manager.close();
  });

  it("does not use qmd query JSON from a non-crash search failure", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "query") {
        const child = createMockChild({ autoClose: false });
        queueMicrotask(() => {
          child.stdout.emit("data", "[]");
          child.stderr.emit("data", "SQLITE_BUSY: database is locked");
          child.closeWith(2);
        });
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    await expect(
      manager.search("router glacier backup", { sessionKey: "agent:main:slack:dm:u123" }),
    ).rejects.toThrow(/SQLITE_BUSY: database is locked/);
    expect(logWarnMock).not.toHaveBeenCalledWith(
      expect.stringContaining("using captured search results"),
    );
    await manager.close();
  });

  it("repairs missing managed collections and retries search once", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          searchMode: "search",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    const expectedDocId = "abc123";
    let missingCollectionSeen = false;
    let addCallsAfterMissing = 0;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      if (args[0] === "collection" && args[1] === "add") {
        if (missingCollectionSeen) {
          addCallsAfterMissing += 1;
        }
        return createMockChild();
      }
      if (args[0] === "search") {
        const collectionFlagIndex = args.indexOf("-c");
        const collection = collectionFlagIndex >= 0 ? args[collectionFlagIndex + 1] : "";
        if (collection === "memory-root-main" && !missingCollectionSeen) {
          missingCollectionSeen = true;
          const child = createMockChild({ autoClose: false });
          queueMicrotask(() => {
            child.stdout.emit("data", "[]");
            child.stderr.emit("data", "Collection not found: memory-root-main");
            child.closeWith(1);
          });
          return child;
        }
        if (collection === "memory-root-main") {
          const child = createMockChild({ autoClose: false });
          emitAndClose(
            child,
            "stdout",
            JSON.stringify([{ docid: expectedDocId, score: 1, snippet: "@@ -1,1\nremember this" }]),
          );
          return child;
        }
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    withLeaseMock.mockClear();
    const inner = manager as unknown as {
      db: { prepare: (query: string) => { all: (arg: unknown) => unknown }; close: () => void };
    };
    inner.db = {
      prepare: (_query: string) => ({
        all: (arg: unknown) => {
          if (typeof arg === "string" && arg.startsWith(expectedDocId)) {
            return [{ collection: "memory-root-main", path: "MEMORY.md" }];
          }
          return [];
        },
      }),
      close: () => {},
    };

    const callerController = new AbortController();
    await expect(
      manager.search("remember", {
        sessionKey: "agent:main:slack:dm:u123",
        signal: callerController.signal,
      }),
    ).resolves.toEqual([
      {
        path: "MEMORY.md",
        startLine: 1,
        endLine: 1,
        score: 1,
        snippet: "@@ -1,1\nremember this",
        source: "memory",
      },
    ]);
    expect(addCallsAfterMissing).toBeGreaterThan(0);
    expectMockMessageContains(logWarnMock, "repairing collections and retrying once");
    const [repairLease] = writeLeaseCalls();
    expect(repairLease?.[0].signal?.aborted).toBe(false);
    callerController.abort();
    expect(repairLease?.[0].signal?.aborted).toBe(true);

    await manager.close();
  });

  it("resolves bare qmd command to a Windows-compatible spawn invocation", async () => {
    await withMockedWindowsPlatform(async () => {
      const previousPath = process.env.PATH;
      try {
        const nodeModulesDir = path.join(tmpRoot, "node_modules");
        const shimDir = path.join(nodeModulesDir, ".bin");
        const packageDir = path.join(nodeModulesDir, "qmd");
        const scriptPath = path.join(packageDir, "dist", "cli.js");
        await fs.mkdir(path.dirname(scriptPath), { recursive: true });
        await fs.mkdir(shimDir, { recursive: true });
        await fs.writeFile(path.join(shimDir, "qmd.cmd"), "@echo off\r\n", "utf8");
        await fs.writeFile(
          path.join(packageDir, "package.json"),
          JSON.stringify({ name: "qmd", version: "0.0.0", bin: { qmd: "dist/cli.js" } }),
          "utf8",
        );
        await fs.writeFile(scriptPath, "module.exports = {};\n", "utf8");
        process.env.PATH = `${shimDir};${previousPath ?? ""}`;

        const { manager } = await createManager({ mode: "status" });
        await manager.sync({ reason: "manual" });

        const qmdCalls = spawnMock.mock.calls.filter((call: unknown[]) => {
          const args = call[1] as string[] | undefined;
          return (
            Array.isArray(args) &&
            args.some((token) => token === "update" || token === "search" || token === "query")
          );
        });
        expect(qmdCalls.length).toBeGreaterThan(0);
        for (const call of qmdCalls) {
          const command = String(call[0]);
          const options = call[2] as { shell?: boolean } | undefined;
          expect(command).not.toMatch(/(^|[\\/])qmd\.cmd$/i);
          expect(options?.shell).not.toBe(true);
        }

        await manager.close();
      } finally {
        process.env.PATH = previousPath;
      }
    });
  });

  it("keeps mixed Han-script BM25 queries intact before qmd search", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager, resolved } = await createManager();
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }

    await expect(
      manager.search("記憶系統升級 QMD", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toStrictEqual([]);

    const searchCall = spawnMock.mock.calls.find(
      (call: unknown[]) => (call[1] as string[])?.[0] === "search",
    );
    expect(searchCall?.[1]).toEqual([
      "search",
      "記憶系統升級 QMD",
      "--json",
      "-n",
      String(maxResults),
      "-c",
      "workspace-main",
    ]);
    await manager.close();
  });

  it("falls back to the original query when Han normalization yields no BM25 tokens", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();
    await expect(manager.search("記", { sessionKey: "agent:main:slack:dm:u123" })).resolves.toEqual(
      [],
    );

    const searchCall = spawnMock.mock.calls.find(
      (call: unknown[]) => (call[1] as string[])?.[0] === "search",
    );
    expect(searchCall?.[1]?.[1]).toBe("記");
    await manager.close();
  });

  it("keeps spaced Han queries intact before qmd search", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();
    const query = "自然 高级感 结论先行 搜索偏好";
    await expect(
      manager.search(query, { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toStrictEqual([]);

    const searchCall = spawnMock.mock.calls.find(
      (call: unknown[]) => (call[1] as string[])?.[0] === "search",
    );
    expect(searchCall?.[1]?.[1]).toBe(query);
    await manager.close();
  });

  it("keeps original Han queries in qmd query mode", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "query") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();
    await expect(
      manager.search("記憶系統升級 QMD", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toStrictEqual([]);

    const queryCall = spawnMock.mock.calls.find(
      (call: unknown[]) => (call[1] as string[])?.[0] === "query",
    );
    expect(queryCall?.[1]?.[1]).toBe("記憶系統升級 QMD");
    await manager.close();
  });

  it("retries search with qmd query when configured mode rejects flags", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stderr", "unknown flag: --json", 2);
        return child;
      }
      if (args[0] === "query") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager, resolved } = await createManager();
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }

    await expect(
      manager.search("test", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toStrictEqual([]);

    const searchAndQueryCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1])
      .filter(
        (args): args is string[] => Array.isArray(args) && ["search", "query"].includes(args[0]),
      );
    expect(searchAndQueryCalls).toEqual([
      ["search", "test", "--json", "-n", String(maxResults), "-c", "workspace-main"],
      ["query", "test", "--json", "-n", String(maxResults), "-c", "workspace-main"],
    ]);
    await manager.close();
  });

  it("passes --no-rerank to direct qmd query when query reranking is disabled", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          rerank: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "query") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager, resolved } = await createManager();
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }

    await expect(
      manager.search("test", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toStrictEqual([]);

    const queryCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "query");
    expect(queryCalls).toEqual([
      ["query", "test", "--json", "-n", String(maxResults), "--no-rerank", "-c", "workspace-main"],
    ]);
    await manager.close();
  });

  it("aborts the in-flight qmd search subprocess when the caller signal aborts", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    // The query child never closes on its own so the only way the search can
    // settle is the caller-owned abort signal killing the subprocess.
    let queryChildKill: ReturnType<typeof vi.fn> | undefined;
    let queryChild: MockChild | undefined;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "query") {
        const child = createMockChild({ autoClose: false });
        const kill = vi.fn(() => {
          // Mirror a real child exiting after SIGKILL so the close handler runs.
          queueMicrotask(() => child.emit("close", null));
        });
        Object.assign(child, { kill });
        queryChildKill = kill;
        queryChild = child;
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();
    const controller = new AbortController();

    const searchPromise = manager.search("test", {
      sessionKey: "agent:main:slack:dm:u123",
      signal: controller.signal,
    });
    searchPromise.catch(() => undefined);

    await waitUntil(() => queryChildKill !== undefined);
    expect(queryChild).toBeDefined();

    controller.abort(new Error("memory_search timed out after 15s"));

    await expect(searchPromise).rejects.toThrow("memory_search timed out after 15s");
    expect(queryChildKill).toHaveBeenCalledWith("SIGKILL");
    await manager.close();
  });

  it("rejects the qmd search before spawning when the caller signal is already aborted", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const { manager } = await createManager();
    const controller = new AbortController();
    controller.abort(new Error("memory_search timed out after 15s"));

    const callsBefore = spawnMock.mock.calls.filter(
      (call: unknown[]) => (call[1] as string[])?.[0] === "query",
    ).length;

    await expect(
      manager.search("test", {
        sessionKey: "agent:main:slack:dm:u123",
        signal: controller.signal,
      }),
    ).rejects.toThrow("memory_search timed out after 15s");

    const callsAfter = spawnMock.mock.calls.filter(
      (call: unknown[]) => (call[1] as string[])?.[0] === "query",
    ).length;
    expect(callsAfter).toBe(callsBefore);
    await manager.close();
  });

  it("aborts the in-flight grouped qmd search subprocess when the caller signal aborts", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          sessions: { enabled: true },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    // Mixed memory/session sources route the search through
    // runQueryAcrossCollectionGroups. The first grouped search child never
    // closes on its own, so the only way the search can settle is the
    // caller-owned abort signal reaching the grouped subprocess and killing it.
    let groupedChildKill: ReturnType<typeof vi.fn> | undefined;
    let groupedChild: MockChild | undefined;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "--help") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          "-c, --collection <name>    Filter by one or more collections",
        );
        return child;
      }
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        const kill = vi.fn(() => {
          // Mirror a real child exiting after SIGKILL so the close handler runs.
          queueMicrotask(() => child.emit("close", null));
        });
        Object.assign(child, { kill });
        if (!groupedChildKill) {
          groupedChildKill = kill;
          groupedChild = child;
        }
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();
    const controller = new AbortController();

    const searchPromise = manager.search("test", {
      sessionKey: "agent:main:slack:dm:u123",
      signal: controller.signal,
    });
    searchPromise.catch(() => undefined);

    await waitUntil(() => groupedChildKill !== undefined);
    expect(groupedChild).toBeDefined();

    controller.abort(new Error("memory_search timed out after 15s"));

    await expect(searchPromise).rejects.toThrow("memory_search timed out after 15s");
    expect(groupedChildKill).toHaveBeenCalledWith("SIGKILL");
    await manager.close();
  });

  it("aborts the multi-collection capability probe without caching a failure", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [
            { path: workspaceDir, pattern: "**/*.md", name: "workspace" },
            { path: path.join(workspaceDir, "notes"), pattern: "**/*.md", name: "notes" },
          ],
        },
      },
    } as OpenClawConfig;

    let helpChildKill: ReturnType<typeof vi.fn> | undefined;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "--help") {
        const child = createMockChild({ autoClose: false });
        const kill = vi.fn(() => {
          queueMicrotask(() => child.emit("close", null));
        });
        Object.assign(child, { kill });
        helpChildKill = kill;
        return child;
      }
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();
    const controller = new AbortController();
    const searchPromise = manager.search("test", {
      sessionKey: "agent:main:slack:dm:u123",
      signal: controller.signal,
    });
    searchPromise.catch(() => undefined);

    await waitUntil(() => helpChildKill !== undefined);
    controller.abort(new Error("memory_search timed out after 15s"));

    await expect(searchPromise).rejects.toThrow("memory_search timed out after 15s");
    expect(helpChildKill).toHaveBeenCalledWith("SIGKILL");
    expect(
      spawnMock.mock.calls.some((call: unknown[]) => (call[1] as string[])?.[0] === "search"),
    ).toBe(false);
    await manager.close();
  });

  it("aborts the in-flight mcporter search subprocess when the caller signal aborts", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    // The mcporter `call` child never closes on its own, so the only way the
    // search can settle is the caller-owned abort signal reaching the mcporter
    // subprocess via runMcporter -> runCliCommand and killing it.
    let mcporterCallKill: ReturnType<typeof vi.fn> | undefined;
    let mcporterCallChild: MockChild | undefined;
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      if (isMcporterCommand(cmd) && args[0] === "call") {
        const child = createMockChild({ autoClose: false });
        const kill = vi.fn(() => {
          // Mirror a real child exiting after SIGKILL so the close handler runs.
          queueMicrotask(() => child.emit("close", null));
        });
        Object.assign(child, { kill });
        mcporterCallKill = kill;
        mcporterCallChild = child;
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();
    const controller = new AbortController();

    const searchPromise = manager.search("test", {
      sessionKey: "agent:main:slack:dm:u123",
      signal: controller.signal,
    });
    searchPromise.catch(() => undefined);

    await waitUntil(() => mcporterCallKill !== undefined);
    expect(mcporterCallChild).toBeDefined();

    controller.abort(new Error("memory_search timed out after 15s"));

    await expect(searchPromise).rejects.toThrow("memory_search timed out after 15s");
    expect(mcporterCallKill).toHaveBeenCalledWith("SIGKILL");
    await manager.close();
  });

  it("rejects the mcporter search before spawning a call subprocess when the caller signal is already aborted", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();
    const controller = new AbortController();
    controller.abort(new Error("memory_search timed out after 15s"));

    const callsBefore = spawnMock.mock.calls.filter(
      (call: unknown[]) => isMcporterCommand(call[0]) && (call[1] as string[])?.[0] === "call",
    ).length;

    await expect(
      manager.search("test", {
        sessionKey: "agent:main:slack:dm:u123",
        signal: controller.signal,
      }),
    ).rejects.toThrow("memory_search timed out after 15s");

    const callsAfter = spawnMock.mock.calls.filter(
      (call: unknown[]) => isMcporterCommand(call[0]) && (call[1] as string[])?.[0] === "call",
    ).length;
    expect(callsAfter).toBe(callsBefore);
    await manager.close();
  });

  it("does not pass --no-rerank to direct query fallback from search mode", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          rerank: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stderr", "unknown flag: --json", 2);
        return child;
      }
      if (args[0] === "query") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager, resolved } = await createManager();
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }

    await expect(
      manager.search("test", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toStrictEqual([]);

    const searchAndQueryCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1])
      .filter(
        (args): args is string[] => Array.isArray(args) && ["search", "query"].includes(args[0]),
      );
    expect(searchAndQueryCalls).toEqual([
      ["search", "test", "--json", "-n", String(maxResults), "-c", "workspace-main"],
      ["query", "test", "--json", "-n", String(maxResults), "-c", "workspace-main"],
    ]);
    await manager.close();
  });

  it("queues a forced sync behind an in-flight update", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: {
            interval: "0s",
            debounceMs: 0,
            onBoot: false,
            updateTimeoutMs: 1_000,
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const firstUpdateSpawned = createDeferred<void>();
    let updateCalls = 0;
    let releaseFirstUpdate: (() => void) | null = null;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        updateCalls += 1;
        if (updateCalls === 1) {
          const first = createMockChild({ autoClose: false });
          releaseFirstUpdate = () => first.closeWith(0);
          firstUpdateSpawned.resolve();
          return first;
        }
        return createMockChild();
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    const inFlight = manager.sync({ reason: "interval" });
    const forced = manager.sync({ reason: "manual", force: true });

    await firstUpdateSpawned.promise;
    expect(updateCalls).toBe(1);
    if (!releaseFirstUpdate) {
      throw new Error("first update release missing");
    }
    (releaseFirstUpdate as () => void)();

    await Promise.all([inFlight, forced]);
    expect(updateCalls).toBe(2);
    await manager.close();
  });

  it("honors multiple forced sync requests while forced queue is active", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: {
            interval: "0s",
            debounceMs: 0,
            onBoot: false,
            updateTimeoutMs: 1_000,
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const firstUpdateSpawned = createDeferred<void>();
    const secondUpdateSpawned = createDeferred<void>();
    let updateCalls = 0;
    let releaseFirstUpdate: (() => void) | null = null;
    let releaseSecondUpdate: (() => void) | null = null;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        updateCalls += 1;
        if (updateCalls === 1) {
          const first = createMockChild({ autoClose: false });
          releaseFirstUpdate = () => first.closeWith(0);
          firstUpdateSpawned.resolve();
          return first;
        }
        if (updateCalls === 2) {
          const second = createMockChild({ autoClose: false });
          releaseSecondUpdate = () => second.closeWith(0);
          secondUpdateSpawned.resolve();
          return second;
        }
        return createMockChild();
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    const inFlight = manager.sync({ reason: "interval" });
    const forcedOne = manager.sync({ reason: "manual", force: true });

    await firstUpdateSpawned.promise;
    expect(updateCalls).toBe(1);
    if (!releaseFirstUpdate) {
      throw new Error("first update release missing");
    }
    (releaseFirstUpdate as () => void)();

    await secondUpdateSpawned.promise;
    const forcedTwo = manager.sync({ reason: "manual-again", force: true });

    if (!releaseSecondUpdate) {
      throw new Error("second update release missing");
    }
    (releaseSecondUpdate as () => void)();

    await Promise.all([inFlight, forcedOne, forcedTwo]);
    expect(updateCalls).toBe(3);
    await manager.close();
  });

  it("scopes qmd queries to managed collections", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [
            { path: workspaceDir, pattern: "**/*.md", name: "workspace" },
            { path: path.join(workspaceDir, "notes"), pattern: "**/*.md", name: "notes" },
          ],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager, resolved } = await createManager();

    await manager.search("test", { sessionKey: "agent:main:slack:dm:u123" });
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }
    const searchCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "search");
    expect(searchCalls).toEqual([
      ["search", "test", "--json", "-n", String(maxResults), "-c", "workspace-main"],
      ["search", "test", "--json", "-n", String(maxResults), "-c", "notes-main"],
    ]);
    await manager.close();
  });

  it("groups same-source qmd queries when the installed qmd supports multiple collection filters", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [
            { path: workspaceDir, pattern: "**/*.md", name: "workspace" },
            { path: path.join(workspaceDir, "notes"), pattern: "**/*.md", name: "notes" },
          ],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "--help") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          "-c, --collection <name>    Filter by one or more collections",
        );
        return child;
      }
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager, resolved } = await createManager();

    await manager.search("test", { sessionKey: "agent:main:slack:dm:u123" });
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }
    const searchCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "search");
    expect(searchCalls).toEqual([
      [
        "search",
        "test",
        "--json",
        "-n",
        String(maxResults),
        "-c",
        "workspace-main",
        "-c",
        "notes-main",
      ],
    ]);
    await manager.close();
  });

  it("keeps mixed-source qmd queries in separate source groups", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          sessions: { enabled: true },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "--help") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          "-c, --collection <name>    Filter by one or more collections",
        );
        return child;
      }
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager, resolved } = await createManager();

    await manager.search("test", { sessionKey: "agent:main:slack:dm:u123" });
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }
    const searchCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "search");
    expect(searchCalls).toEqual([
      ["search", "test", "--json", "-n", String(maxResults), "-c", "workspace-main"],
      ["search", "test", "--json", "-n", String(maxResults), "-c", "sessions-main"],
    ]);
    await manager.close();
  });

  it("does not query phantom memory-alt collections when MEMORY.md exists", async () => {
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# canonical root");
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager, resolved } = await createManager();

    await manager.search("test", { sessionKey: "agent:main:slack:dm:u123" });
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }
    const searchCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "search");
    expect(searchCalls).toEqual([
      ["search", "test", "--json", "-n", String(maxResults), "-c", "memory-root-main"],
      ["search", "test", "--json", "-n", String(maxResults), "-c", "memory-dir-main"],
    ]);
    await manager.close();
  });

  it("uses explicit external custom collection names verbatim at query time", async () => {
    const sharedMirrorDir = path.join(tmpRoot, "shared-notion-mirror");
    await fs.mkdir(sharedMirrorDir);
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: sharedMirrorDir, pattern: "**/*.md", name: "notion-mirror" }],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager, resolved } = await createManager();

    await manager.search("test", { sessionKey: "agent:main:slack:dm:u123" });
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }
    const searchCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "search");
    expect(searchCalls).toEqual([
      ["search", "test", "--json", "-n", String(maxResults), "-c", "notion-mirror"],
    ]);
    await manager.close();
  });

  it("runs qmd query per collection when query mode has multiple collection filters", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [
            { path: workspaceDir, pattern: "**/*.md", name: "workspace" },
            { path: path.join(workspaceDir, "notes"), pattern: "**/*.md", name: "notes" },
          ],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "query") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager, resolved } = await createManager();
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }

    await expect(
      manager.search("test", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toStrictEqual([]);

    const queryCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "query");
    expect(queryCalls).toEqual([
      ["query", "test", "--json", "-n", String(maxResults), "-c", "workspace-main"],
      ["query", "test", "--json", "-n", String(maxResults), "-c", "notes-main"],
    ]);
    await manager.close();
  });

  it("uses per-collection query fallback when search mode rejects flags", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [
            { path: workspaceDir, pattern: "**/*.md", name: "workspace" },
            { path: path.join(workspaceDir, "notes"), pattern: "**/*.md", name: "notes" },
          ],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stderr", "unknown flag: --json", 2);
        return child;
      }
      if (args[0] === "query") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager, resolved } = await createManager();
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }

    await expect(
      manager.search("test", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toStrictEqual([]);

    const searchAndQueryCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "search" || args[0] === "query");
    expect(searchAndQueryCalls).toEqual([
      ["search", "test", "--json", "-n", String(maxResults), "-c", "workspace-main"],
      ["query", "test", "--json", "-n", String(maxResults), "-c", "workspace-main"],
      ["query", "test", "--json", "-n", String(maxResults), "-c", "notes-main"],
    ]);
    await manager.close();
  });

  it("runs qmd searches via mcporter and warns when startDaemon=false", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();

    logWarnMock.mockClear();
    await expect(
      manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toStrictEqual([]);

    const mcporterCalls = spawnMock.mock.calls.filter((call: unknown[]) =>
      isMcporterCommand(call[0]),
    );
    expect(mcporterCalls.length).toBeGreaterThan(0);
    expect(mcporterCalls.map((call: unknown[]) => (call[1] as string[])[0])).not.toContain(
      "daemon",
    );
    expectMockMessageContains(logWarnMock, "cold-start");

    await manager.close();
  });

  it("uses QMD 1.1+ query tool with searches array via mcporter", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    const commandPhases: string[] = [];
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        expect(commandPhases).toEqual(["pause"]);
        // Verify it calls qmd.query (v2) not qmd.deep_search (v1)
        expect(args[1]).toBe("qmd.query");
        const callArgs = JSON.parse(requireArgAfter(args, "--args"));
        // Verify QMD 1.1+ searches array format
        expect(callArgs).toHaveProperty("searches");
        expect(Array.isArray(callArgs.searches)).toBe(true);
        const searchTypes = callArgs.searches.map((search: { type?: unknown }) => search.type);
        expect(searchTypes).toContain("lex");
        expect(searchTypes).toContain("vec");
        expect(searchTypes).toContain("hyde");
        expect(callArgs).toHaveProperty("collections", ["workspace-main"]);
        // Should NOT have flat query/minScore (v1 format)
        expect(callArgs).not.toHaveProperty("query");
        expect(callArgs).not.toHaveProperty("minScore");
        expect(callArgs).not.toHaveProperty("collection");
        expect(callArgs).not.toHaveProperty("rerank");
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();
    await manager.search("hello", {
      sessionKey: "agent:main:slack:dm:u123",
      [MEMORY_SEARCH_DEADLINE_CONTROL]: (action) => {
        commandPhases.push(action);
      },
    });
    expect(commandPhases).toEqual(["pause", "resume"]);
    await manager.close();
  });

  it("passes rerank false to QMD 1.1+ query tool via mcporter when query reranking is disabled", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          rerank: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        expect(args[1]).toBe("qmd.query");
        const callArgs = JSON.parse(requireArgAfter(args, "--args"));
        expect(callArgs).toMatchObject({
          searches: [
            { type: "lex", query: "hello" },
            { type: "vec", query: "hello" },
            { type: "hyde", query: "hello" },
          ],
          limit: expect.any(Number),
          collections: ["workspace-main"],
          rerank: false,
        });
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();
    await manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" });
    await manager.close();
  });

  it("disables the LLM reranker (rerank:false) for vsearch mode via mcporter", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "vsearch",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    let captured: Record<string, unknown> | null = null;
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        captured = JSON.parse(requireArgAfter(args, "--args"));
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();
    await manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" });
    await manager.close();

    expect(captured).not.toBeNull();
    const sentArgs = captured as unknown as Record<string, unknown>;
    // vsearch is a vector-only mode (see buildV2Searches) — it must NOT trigger
    // QMD's LLM reranker, which the "query" tool enables by default.
    expect(sentArgs.rerank).toBe(false);
    const searchTypes = (sentArgs.searches as Array<{ type?: unknown }>).map((s) => s.type);
    expect(searchTypes).toEqual(["vec"]);
  });

  it("keeps hyphenated tokens in lexical QMD searches while normalizing semantic searches", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        expect(args[1]).toBe("qmd.query");
        const callArgs = JSON.parse(requireArgAfter(args, "--args"));
        expect(callArgs.searches).toEqual([
          { type: "lex", query: "sqlite-vec-qmd backend health 2026-05-04 multi-agent" },
          { type: "vec", query: "sqlite vec qmd backend health 2026 05 04 multi agent" },
          { type: "hyde", query: "sqlite vec qmd backend health 2026 05 04 multi agent" },
        ]);
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();
    await manager.search("sqlite-vec-qmd backend health 2026-05-04 multi-agent", {
      sessionKey: "agent:main:slack:dm:u123",
    });
    await manager.close();
  });

  it("normalizes hyphenated tokens for vector-only QMD searches", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "vsearch",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        expect(args[1]).toBe("qmd.query");
        const callArgs = JSON.parse(requireArgAfter(args, "--args"));
        expect(callArgs.searches).toEqual([{ type: "vec", query: "sqlite vec backend health" }]);
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();
    await manager.search("sqlite-vec backend health", {
      sessionKey: "agent:main:slack:dm:u123",
    });
    await manager.close();
  });

  it("wraps non-JSON mcporter stdout as a typed error instead of a raw SyntaxError", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        // mcporter exits 0 but prints non-JSON to stdout (daemon warning, truncated
        // output, or CLI flag mismatch). Without the guard this throws a raw
        // SyntaxError out of runQmdSearchViaMcporter; the guard wraps it.
        emitAndClose(child, "stdout", "mcporter: daemon warning: connection unstable\n");
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();
    await expect(
      manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" }),
    ).rejects.toThrow(/non-JSON stdout/i);
    await manager.close();
  });

  it("falls back to QMD <1.1 tool names when query tool is not found", async () => {
    // qmdMcpToolVersion is an instance field — each createManager() starts fresh.

    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    let callCount = 0;
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        callCount++;
        const toolSelector = args[1];
        if (toolSelector === "qmd.query") {
          // Simulate QMD <1.1 — "query" tool does not exist
          // The error message appears in stdout (mcporter wraps MCP errors in JSON output)
          queueMicrotask(() => {
            child.stderr.emit("data", "MCP error -32602: Tool query not found");
            child.closeWith(1);
          });
          return child;
        }
        if (toolSelector === "qmd.deep_search") {
          // v1 tool exists — verify v1 args format
          const callArgs = JSON.parse(requireArgAfter(args, "--args"));
          expect(callArgs).toHaveProperty("query");
          expect(callArgs).not.toHaveProperty("searches");
          // Return empty results (avoids needing a SQLite fixture)
          emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
          return child;
        }
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();
    // The first search should try v2, fail, then retry with v1
    await manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" });

    // Should have logged the v1 fallback warning
    expectMockMessageContains(logWarnMock, "falling back to v1 tool names");

    // One v2 attempt (fails) + one v1 retry (succeeds) per collection
    expect(callCount).toBe(2);

    await manager.close();
  });

  it("uses an explicit mcporter search tool override with flat query args", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          searchTool: "hybrid_search",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    let expectedLimit = 0;
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        expect(args[1]).toBe("qmd.hybrid_search");
        const callArgs = JSON.parse(requireArgAfter(args, "--args"));
        expect(callArgs.query).toBe("hello");
        expect(callArgs.limit).toBe(expectedLimit);
        expect(callArgs.minScore).toBe(0);
        expect(callArgs.collection).toBe("workspace-main");
        expect(callArgs).not.toHaveProperty("searches");
        expect(callArgs).not.toHaveProperty("collections");
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager, resolved } = await createManager();
    expectedLimit = resolved.qmd?.limits.maxResults ?? 0;
    await manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" });
    await manager.close();
  });

  it("prefers mcporter start and end lines over snippet header offsets", async () => {
    const expectedDocId = "line-123";
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        expect(args[1]).toBe("qmd.query");
        emitAndClose(
          child,
          "stdout",
          JSON.stringify({
            results: [
              {
                docid: expectedDocId,
                score: 0.91,
                collection: "workspace-main",
                start_line: 8,
                end_line: 10,
                snippet: "@@ -20,3\nline one\nline two\nline three",
              },
            ],
          }),
        );
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();
    const inner = manager as unknown as {
      db: { prepare: (query: string) => { all: (arg: unknown) => unknown }; close: () => void };
    };
    inner.db = {
      prepare: (_query: string) => ({
        all: (arg: unknown) => {
          if (typeof arg === "string" && arg.startsWith(expectedDocId)) {
            return [{ collection: "workspace-main", path: "notes/welcome.md" }];
          }
          return [];
        },
      }),
      close: () => {},
    };

    await expect(
      manager.search("line one", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([
      {
        path: "notes/welcome.md",
        startLine: 8,
        endLine: 10,
        score: 0.91,
        snippet: "@@ -20,3\nline one\nline two\nline three",
        source: "memory",
      },
    ]);

    await manager.close();
  });

  it("keeps per-result and aggregate QMD snippet limits UTF-16 safe", async () => {
    const expectedDocId = "unicode-boundary";
    const snippet = "@@ -1,1\nabc😀tail";
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        emitAndClose(
          child,
          "stdout",
          JSON.stringify({
            results: [
              {
                docid: expectedDocId,
                score: 0.91,
                collection: "workspace-main",
                snippet,
              },
            ],
          }),
        );
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const searchWithLimits = async (limits: {
      maxSnippetChars: number;
      maxInjectedChars: number;
    }) => {
      const testConfig = {
        ...cfg,
        memory: {
          backend: "qmd",
          qmd: {
            includeDefaultMemory: false,
            searchMode: "query",
            update: { interval: "0s", debounceMs: 60_000, onBoot: false },
            paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
            limits,
            mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
          },
        },
      } as OpenClawConfig;
      const { manager } = await createManager({ cfg: testConfig });
      const inner = manager as unknown as {
        db: { prepare: () => { all: () => unknown }; close: () => void };
      };
      inner.db = {
        prepare: () => ({
          all: () => [{ collection: "workspace-main", path: "notes/unicode.md" }],
        }),
        close: () => {},
      };
      const results = await manager.search("unicode", {
        sessionKey: "agent:main:slack:dm:u123",
      });
      await manager.close();
      return results;
    };

    await expect(searchWithLimits({ maxSnippetChars: 12, maxInjectedChars: 100 })).resolves.toEqual(
      [expect.objectContaining({ snippet: "@@ -1,1\nabc" })],
    );
    await expect(searchWithLimits({ maxSnippetChars: 100, maxInjectedChars: 12 })).resolves.toEqual(
      [expect.objectContaining({ snippet: "@@ -1,1\nabc" })],
    );
  });

  it("uses snippet header width when mcporter only returns a start line", async () => {
    const expectedDocId = "line-456";
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        expect(args[1]).toBe("qmd.query");
        emitAndClose(
          child,
          "stdout",
          JSON.stringify({
            results: [
              {
                docid: expectedDocId,
                score: 0.73,
                collection: "workspace-main",
                start_line: 8,
                snippet: "@@ -20,3\nline one\nline two\nline three",
              },
            ],
          }),
        );
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();
    const inner = manager as unknown as {
      db: { prepare: (query: string) => { all: (arg: unknown) => unknown }; close: () => void };
    };
    inner.db = {
      prepare: (_query: string) => ({
        all: (arg: unknown) => {
          if (typeof arg === "string" && arg.startsWith(expectedDocId)) {
            return [{ collection: "workspace-main", path: "notes/welcome.md" }];
          }
          return [];
        },
      }),
      close: () => {},
    };

    await expect(
      manager.search("line one", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([
      {
        path: "notes/welcome.md",
        startLine: 8,
        endLine: 10,
        score: 0.73,
        snippet: "@@ -20,3\nline one\nline two\nline three",
        source: "memory",
      },
    ]);

    await manager.close();
  });

  it('uses unified v2 args when the explicit mcporter search tool override is "query"', async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          searchTool: "query",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        expect(args[1]).toBe("qmd.query");
        const callArgs = JSON.parse(requireArgAfter(args, "--args"));
        expect(callArgs).toHaveProperty("searches", [{ type: "lex", query: "hello" }]);
        expect(callArgs).toHaveProperty("collections", ["workspace-main"]);
        expect(callArgs).not.toHaveProperty("query");
        expect(callArgs).not.toHaveProperty("minScore");
        expect(callArgs).not.toHaveProperty("collection");
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();
    await manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" });
    await manager.close();
  });

  it('passes rerank false when explicit mcporter search tool override is "query"', async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          searchTool: "query",
          rerank: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        expect(args[1]).toBe("qmd.query");
        const callArgs = JSON.parse(requireArgAfter(args, "--args"));
        expect(callArgs).toMatchObject({
          searches: [
            { type: "lex", query: "hello" },
            { type: "vec", query: "hello" },
            { type: "hyde", query: "hello" },
          ],
          collections: ["workspace-main"],
          rerank: false,
        });
        expect(callArgs).not.toHaveProperty("query");
        expect(callArgs).not.toHaveProperty("minScore");
        expect(callArgs).not.toHaveProperty("collection");
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();
    await manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" });
    await manager.close();
  });

  it('reuses the cached v1 tool across collections when the explicit mcporter override is "query"', async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          searchTool: "query",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [
            { path: path.join(workspaceDir, "notes-a"), pattern: "**/*.md", name: "workspace-a" },
            { path: path.join(workspaceDir, "notes-b"), pattern: "**/*.md", name: "workspace-b" },
          ],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    const selectors: string[] = [];
    let expectedLimit = 0;
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        const selector = args[1] ?? "";
        selectors.push(selector);
        if (selector === "qmd.query") {
          queueMicrotask(() => {
            child.stderr.emit("data", "MCP error -32602: Tool query not found");
            child.closeWith(1);
          });
          return child;
        }
        const callArgs = JSON.parse(requireArgAfter(args, "--args"));
        expect(selector).toBe("qmd.search");
        expect(callArgs.query).toBe("hello");
        expect(callArgs.limit).toBe(expectedLimit);
        expect(callArgs.minScore).toBe(0);
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager, resolved } = await createManager();
    expectedLimit = resolved.qmd?.limits.maxResults ?? 0;
    await manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" });

    expect(selectors).toEqual(["qmd.query", "qmd.search", "qmd.search"]);

    await manager.close();
  });

  it("uses an explicit mcporter search tool override across multiple collections", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          searchTool: "hybrid_search",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [
            { path: path.join(workspaceDir, "notes-a"), pattern: "**/*.md", name: "workspace-a" },
            { path: path.join(workspaceDir, "notes-b"), pattern: "**/*.md", name: "workspace-b" },
          ],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    const selectors: string[] = [];
    const collections: string[] = [];
    let expectedLimit = 0;
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        selectors.push(args[1] ?? "");
        const callArgs = JSON.parse(requireArgAfter(args, "--args"));
        collections.push(String(callArgs.collection ?? ""));
        expect(callArgs.query).toBe("hello");
        expect(callArgs.limit).toBe(expectedLimit);
        expect(callArgs.minScore).toBe(0);
        expect(callArgs).not.toHaveProperty("searches");
        expect(callArgs).not.toHaveProperty("collections");
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager, resolved } = await createManager();
    expectedLimit = resolved.qmd?.limits.maxResults ?? 0;
    await manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" });

    expect(selectors).toEqual(["qmd.hybrid_search", "qmd.hybrid_search"]);
    expect(collections).toEqual(["workspace-a-main", "workspace-b-main"]);

    await manager.close();
  });

  it("does not pin v1 fallback when only the serialized query text contains tool-not-found words", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    const selectors: string[] = [];
    let firstQueryCall = true;
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        selectors.push(args[1] ?? "");
        if (args[1] === "qmd.query" && firstQueryCall) {
          firstQueryCall = false;
          queueMicrotask(() => {
            child.stderr.emit("data", "backend unavailable");
            child.closeWith(1);
          });
          return child;
        }
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();

    await expect(
      manager.search("abc: Tool query not found", {
        sessionKey: "agent:main:slack:dm:u123",
      }),
    ).resolves.toStrictEqual([]);

    await manager.search("hello again", { sessionKey: "agent:main:slack:dm:u123" });

    expect(selectors.length).toBeGreaterThanOrEqual(2);
    expect(selectors.every((selector) => selector === "qmd.query")).toBe(true);
    expectMockMessageNotContains(logWarnMock, "falling back to v1 tool names");

    await manager.close();
  });

  it("does not pin v1 fallback when a timed out query contains tool-not-found words", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    const selectors: string[] = [];
    let firstQueryCall = true;
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        selectors.push(args[1] ?? "");
        if (args[1] === "qmd.query" && firstQueryCall) {
          firstQueryCall = false;
          return child;
        }
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();
    const commandClient = (
      manager as object as {
        commands: {
          runMcporter: (
            args: string[],
            opts?: { timeoutMs?: number; signal?: AbortSignal },
          ) => Promise<{ stdout: string; stderr: string }>;
        };
      }
    ).commands;
    const originalRunMcporter = commandClient.runMcporter.bind(commandClient);
    let injectTimeoutOnce = true;
    const runMcporterSpy = vi
      .spyOn(commandClient, "runMcporter")
      .mockImplementation(async (...args) => {
        if (injectTimeoutOnce) {
          injectTimeoutOnce = false;
          firstQueryCall = false;
          throw new Error(
            'mcporter call qmd.query --args {"query":"abc: Tool query not found"} timed out after 5000ms',
          );
        }
        return await originalRunMcporter(...args);
      });

    await expect(
      manager.search("abc: Tool query not found", {
        sessionKey: "agent:main:slack:dm:u123",
      }),
    ).rejects.toThrow("timed out after 5000ms");

    await manager.search("hello again", { sessionKey: "agent:main:slack:dm:u123" });

    expect(runMcporterSpy).toHaveBeenCalled();
    expect(selectors.length).toBeGreaterThanOrEqual(1);
    expect(selectors.every((selector) => selector === "qmd.query")).toBe(true);
    expectMockMessageNotContains(logWarnMock, "falling back to v1 tool names");

    runMcporterSpy.mockRestore();
    await manager.close();
  });

  it("resolves mcporter to a direct Windows entrypoint without enabling shell mode", async () => {
    await withMockedWindowsPlatform(async () => {
      const previousPath = process.env.PATH;
      try {
        const nodeModulesDir = path.join(tmpRoot, "node_modules");
        const shimDir = path.join(nodeModulesDir, ".bin");
        const packageDir = path.join(nodeModulesDir, "mcporter");
        const scriptPath = path.join(packageDir, "dist", "cli.js");
        await fs.mkdir(path.dirname(scriptPath), { recursive: true });
        await fs.mkdir(shimDir, { recursive: true });
        await fs.writeFile(path.join(shimDir, "mcporter.cmd"), "@echo off\r\n", "utf8");
        await fs.writeFile(
          path.join(packageDir, "package.json"),
          JSON.stringify({ name: "mcporter", version: "0.0.0", bin: { mcporter: "dist/cli.js" } }),
          "utf8",
        );
        await fs.writeFile(scriptPath, "module.exports = {};\n", "utf8");
        process.env.PATH = `${shimDir};${previousPath ?? ""}`;

        cfg = {
          ...cfg,
          memory: {
            backend: "qmd",
            qmd: {
              includeDefaultMemory: false,
              update: { interval: "0s", debounceMs: 60_000, onBoot: false },
              paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
              mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
            },
          },
        } as OpenClawConfig;

        spawnMock.mockImplementation((_cmd: string, args: string[]) => {
          const child = createMockChild({ autoClose: false });
          if (args[0] === "call") {
            emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
            return child;
          }
          emitAndClose(child, "stdout", "[]");
          return child;
        });

        const { manager } = await createManager();
        await manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" });

        const mcporterCall = spawnMock.mock.calls.find((call: unknown[]) =>
          (call[1] as string[] | undefined)?.includes("call"),
        );
        const searchCall = requireValue(mcporterCall, "mcporter search call missing");
        const callCommand = searchCall[0];
        expect(typeof callCommand).toBe("string");
        const options = searchCall[2] as { shell?: boolean } | undefined;
        expect(callCommand).not.toBe("mcporter.cmd");
        expect(options?.shell).not.toBe(true);

        await manager.close();
      } finally {
        process.env.PATH = previousPath;
      }
    });
  });

  it("fails closed on Windows EINVAL cmd-shim failures instead of retrying through the shell", async () => {
    await withMockedWindowsPlatform(async () => {
      const previousPath = process.env.PATH;
      try {
        const shimDir = await fs.mkdtemp(path.join(tmpRoot, "mcporter-shim-"));
        await fs.writeFile(path.join(shimDir, "mcporter.cmd"), "@echo off\n");
        process.env.PATH = `${shimDir};${previousPath ?? ""}`;

        cfg = {
          ...cfg,
          memory: {
            backend: "qmd",
            qmd: {
              includeDefaultMemory: false,
              update: { interval: "0s", debounceMs: 60_000, onBoot: false },
              paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
              mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
            },
          },
        } as OpenClawConfig;

        let firstCallCommand: string | null = null;
        spawnMock.mockImplementation((cmd: string, args: string[]) => {
          if (args[0] === "call" && firstCallCommand === null) {
            firstCallCommand = cmd;
          }
          if (args[0] === "call" && typeof cmd === "string" && cmd.toLowerCase().endsWith(".cmd")) {
            const child = createMockChild({ autoClose: false });
            queueMicrotask(() => {
              const err = Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" });
              child.emit("error", err);
            });
            return child;
          }
          const child = createMockChild({ autoClose: false });
          emitAndClose(child, "stdout", "[]");
          return child;
        });

        const { manager } = await createManager();
        await expect(
          manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" }),
        ).rejects.toThrow(/without shell execution|EINVAL/);
        const attemptedCmdShim = (firstCallCommand ?? "").toLowerCase().endsWith(".cmd");
        if (attemptedCmdShim) {
          expect(
            spawnMock.mock.calls.some(
              (call: unknown[]) =>
                call[0] === "mcporter" &&
                (call[2] as { shell?: boolean } | undefined)?.shell === true,
            ),
          ).toBe(false);
        }
        await manager.close();
      } finally {
        process.env.PATH = previousPath;
      }
    });
  });

  it("passes manager-scoped XDG env to mcporter commands", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();
    await manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" });

    const mcporterCall = spawnMock.mock.calls.find(
      (call: unknown[]) => isMcporterCommand(call[0]) && (call[1] as string[])[0] === "call",
    );
    const searchCall = requireValue(mcporterCall, "mcporter search call missing");
    const spawnOpts = searchCall[2] as { env?: NodeJS.ProcessEnv } | undefined;
    const normalizePath = (value?: string) => value?.replace(/\\/g, "/");
    expect(normalizePath(spawnOpts?.env?.XDG_CONFIG_HOME)).toContain("/agents/main/qmd/xdg-config");
    expect(normalizePath(spawnOpts?.env?.QMD_CONFIG_DIR)).toContain(
      "/agents/main/qmd/xdg-config/qmd",
    );
    expect(normalizePath(spawnOpts?.env?.XDG_CACHE_HOME)).toContain("/agents/main/qmd/xdg-cache");
    expect(spawnOpts?.env?.PATH?.split(path.delimiter)).toContain(path.dirname(process.execPath));

    await manager.close();
  });

  it("retries mcporter daemon start after a failure", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: true },
        },
      },
    } as OpenClawConfig;

    let daemonAttempts = 0;
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "daemon") {
        daemonAttempts += 1;
        if (daemonAttempts === 1) {
          emitAndClose(child, "stderr", "failed", 1);
        } else {
          emitAndClose(child, "stdout", "");
        }
        return child;
      }
      if (isMcporterCommand(cmd) && args[0] === "call") {
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();

    await manager.search("one", { sessionKey: "agent:main:slack:dm:u123" });
    await manager.search("two", { sessionKey: "agent:main:slack:dm:u123" });

    expect(daemonAttempts).toBe(2);

    await manager.close();
  });

  it("starts the mcporter daemon only once when enabled", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: true },
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "daemon") {
        emitAndClose(child, "stdout", "");
        return child;
      }
      if (isMcporterCommand(cmd) && args[0] === "call") {
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();

    await manager.search("one", { sessionKey: "agent:main:slack:dm:u123" });
    await manager.search("two", { sessionKey: "agent:main:slack:dm:u123" });

    const daemonStarts = spawnMock.mock.calls.filter(
      (call: unknown[]) => isMcporterCommand(call[0]) && (call[1] as string[])[0] === "daemon",
    );
    expect(daemonStarts).toHaveLength(1);

    await manager.close();
  });

  it("fails closed when no managed collections are configured", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    const { manager } = await createManager();

    const results = await manager.search("test", { sessionKey: "agent:main:slack:dm:u123" });
    expect(results).toStrictEqual([]);
    expect(
      spawnMock.mock.calls.some((call: unknown[]) => (call[1] as string[])?.[0] === "query"),
    ).toBe(false);
    await manager.close();
  });

  it("diversifies mixed session and memory search results so memory hits are retained", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          sessions: { enabled: true },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search" && args.includes("workspace-main")) {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([{ docid: "m1", score: 0.6, snippet: "@@ -1,1\nmemory fact" }]),
        );
        return child;
      }
      if (args[0] === "search" && args.includes("sessions-main")) {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([
            { docid: "s1", score: 0.99, snippet: "@@ -1,1\nsession top 1" },
            { docid: "s2", score: 0.95, snippet: "@@ -1,1\nsession top 2" },
            { docid: "s3", score: 0.91, snippet: "@@ -1,1\nsession top 3" },
            { docid: "s4", score: 0.88, snippet: "@@ -1,1\nsession top 4" },
          ]),
        );
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();
    const inner = manager as unknown as {
      db: { prepare: (_query: string) => { all: (arg: unknown) => unknown }; close: () => void };
    };
    inner.db = {
      prepare: (_query: string) => ({
        all: (arg: unknown) => {
          switch (arg) {
            case "m1":
              return [{ collection: "workspace-main", path: "memory/facts.md" }];
            case "s1":
            case "s2":
            case "s3":
            case "s4":
              return [
                {
                  collection: "sessions-main",
                  path: `${arg}.md`,
                },
              ];
            default:
              return [];
          }
        },
      }),
      close: () => {},
    };

    const results = await manager.search("fact", {
      maxResults: 4,
      sessionKey: "agent:main:slack:dm:u123",
    });

    expect(results).toHaveLength(4);
    const sources = results.map((entry) => entry.source);
    expect(sources).toContain("memory");
    expect(sources).toContain("sessions");
    await manager.close();
  });

  it("logs and continues when qmd embed times out", async () => {
    vi.useFakeTimers();
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: {
            interval: "0s",
            debounceMs: 0,
            onBoot: false,
            embedTimeoutMs: 20,
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "embed") {
        return createMockChild({ autoClose: false });
      }
      return createMockChild();
    });

    const resolved = resolveMemoryBackendConfig({ cfg, agentId });
    const createPromise = QmdMemoryManager.create({
      cfg,
      agentId,
      resolved,
      withLease: withLeaseMock,
      mode: "status",
    });
    await vi.advanceTimersByTimeAsync(0);
    const manager = requireValue(trackManager(await createPromise), "manager missing");
    const syncPromise = manager.sync({ reason: "manual" });
    const resolvedSync = expect(syncPromise).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(20);
    await resolvedSync;
    await manager.close();
  });

  it("does not store qmd embed backoff when the process clock is invalid", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: {
            interval: "0s",
            debounceMs: 0,
            onBoot: false,
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);
    const { manager } = await createManager({ mode: "status" });
    try {
      (
        manager as unknown as {
          noteEmbedFailure: (reason: string, err: unknown) => void;
        }
      ).noteEmbedFailure("manual", new Error("embed failed"));
    } finally {
      dateNowSpy.mockRestore();
    }

    const status = manager.status() as { custom?: { qmd?: { embedBackoffUntil?: number | null } } };
    expect(status.custom?.qmd?.embedBackoffUntil).toBeNull();
    await manager.close();
  });

  it("runs periodic embed maintenance even when regular update scheduling is disabled", async () => {
    vi.useFakeTimers();
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: {
            interval: "0s",
            debounceMs: 0,
            onBoot: false,
            embedInterval: "5m",
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const { manager } = await createManager({ mode: "full" });

    const commandCallsBefore = spawnMock.mock.calls.filter((call: unknown[]) => {
      const args = call[1] as string[];
      return args[0] === "update" || args[0] === "embed";
    });
    expect(commandCallsBefore).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    const commandCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "update" || args[0] === "embed");
    expect(commandCalls).toEqual([["update"], ["embed"]]);

    await manager.close();
  });

  it("runs periodic embed maintenance when embed cadence is faster than update cadence", async () => {
    vi.useFakeTimers();
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: {
            interval: "20m",
            debounceMs: 0,
            onBoot: false,
            embedInterval: "5m",
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const { manager } = await createManager({ mode: "full" });

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    const commandCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "update" || args[0] === "embed");
    expect(commandCalls).toEqual([["update"], ["embed"]]);

    await manager.close();
  });

  it("does not schedule redundant embed maintenance when regular updates are already more frequent", async () => {
    vi.useFakeTimers();
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: {
            interval: "5m",
            debounceMs: 0,
            onBoot: false,
            embedInterval: "20m",
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const { manager } = await createManager({ mode: "full" });

    await vi.advanceTimersByTimeAsync(6 * 60_000);

    const commandCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "update" || args[0] === "embed");
    expect(commandCalls).toEqual([["update"], ["embed"]]);

    await manager.close();
  });

  it("skips periodic embed maintenance in lexical search mode", async () => {
    vi.useFakeTimers();
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          update: {
            interval: "0s",
            debounceMs: 0,
            onBoot: false,
            embedInterval: "5m",
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const { manager } = await createManager({ mode: "full" });

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    const commandCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "update" || args[0] === "embed");
    expect(commandCalls).toStrictEqual([]);

    await manager.close();
  });

  it("delays the first periodic embed maintenance run by stable startup jitter", async () => {
    vi.useFakeTimers();
    embedStartupJitterSpy?.mockRestore();
    embedStartupJitterSpy = vi
      .spyOn(
        QmdMemoryManager.prototype as unknown as {
          resolveEmbedStartupJitterMs: () => number;
        },
        "resolveEmbedStartupJitterMs",
      )
      .mockReturnValue(60_000);
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: {
            interval: "0s",
            debounceMs: 0,
            onBoot: false,
            embedInterval: "5m",
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const { manager } = await createManager({ mode: "full" });

    await vi.advanceTimersByTimeAsync(59_999);
    const beforeCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "update" || args[0] === "embed");
    expect(beforeCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    const commandCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "update" || args[0] === "embed");
    expect(commandCalls).toEqual([["update"], ["embed"]]);

    await manager.close();
  });

  it("serializes qmd embeds within a process before taking the shared SQLite lease", async () => {
    vi.useFakeTimers();
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    const embedChildren: MockChild[] = [];
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "embed") {
        const child = createMockChild({ autoClose: false });
        embedChildren.push(child);
        return child;
      }
      return createMockChild();
    });

    const first = await createManager({ mode: "status" });
    const second = await createManager({ mode: "status" });
    withLeaseMock.mockClear();
    const firstSync = first.manager.sync({ reason: "manual", force: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(embedChildren).toHaveLength(1);
    const [leaseOptions, leaseTask] = firstEmbedLeaseCall();
    expect(leaseOptions).toMatchObject({
      namespace: "qmd",
      key: "embed",
      database: { scope: "shared" },
      leaseMs: 15 * 60 * 1000,
      waitMs: 15 * 60 * 1000,
    });
    expect(typeof leaseTask).toBe("function");

    const secondSync = second.manager.sync({ reason: "manual", force: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(embedChildren).toHaveLength(1);

    embedChildren[0]?.closeWith(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(embedChildren).toHaveLength(2);

    embedChildren[1]?.closeWith(0);
    await expect(firstSync).resolves.toBeUndefined();
    await expect(secondSync).resolves.toBeUndefined();
    await first.manager.close();
    await second.manager.close();
  });

  it("drops a queued embed when its manager closes", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    const embedChildren: MockChild[] = [];
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "embed") {
        const child = createMockChild({ autoClose: false });
        embedChildren.push(child);
        return child;
      }
      return createMockChild();
    });

    const first = await createManager({ mode: "status" });
    const second = await createManager({ mode: "status" });
    withLeaseMock.mockClear();
    const firstSync = first.manager.sync({ reason: "manual", force: true });
    await waitUntil(() => embedChildren.length === 1);
    const secondSync = second.manager.sync({ reason: "manual", force: true });
    await waitUntil(() => writeLeaseCalls().length >= 3);

    await second.manager.close();
    await expect(secondSync).resolves.toBeUndefined();
    expect(embedChildren).toHaveLength(1);

    embedChildren[0]?.closeWith(0);
    await expect(firstSync).resolves.toBeUndefined();
    await first.manager.close();
  });

  it("serializes both the qmd update and embed writes on one per-agent lease (issue #66339)", async () => {
    // Regression for #66339: the update AND embed phases both write the same
    // qmd index.sqlite. A foreground `memory search` dirty-sync and a background
    // gateway update/embed run in separate processes, which the in-process queues
    // cannot serialize, so the writers collided with SQLITE_BUSY. Both writes now
    // take one per-agent SQLite write lease; embed additionally keeps the
    // global SQLite lease for ML-resource serialization.
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    spawnMock.mockImplementation(() => createMockChild());

    const { manager } = await createManager({ mode: "status" });
    withLeaseMock.mockClear();
    await expect(manager.sync({ reason: "manual", force: true })).resolves.toBeUndefined();

    const [leaseOptions, leaseTask] = firstWriteLeaseCall();
    expect(leaseOptions).toMatchObject({
      namespace: "qmd",
      key: "write",
      database: { scope: "agent", agentId },
    });
    expect(leaseOptions.leaseMs).toBeGreaterThanOrEqual(5 * 60 * 1000);
    expect(leaseOptions.waitMs).toBeGreaterThanOrEqual(5 * 60 * 1000);
    expect(typeof leaseTask).toBe("function");

    // A forced sync runs both the update and the embed write, so both acquire the
    // shared per-agent write lease; the embed also still takes the global embed lease.
    expect(writeLeaseCalls().length).toBeGreaterThanOrEqual(2);
    const embedLeaseTaken = withLeaseMock.mock.calls.some(
      (entry) => entry[0].database.scope === "shared" && entry[0].key === "embed",
    );
    expect(embedLeaseTaken).toBe(true);

    await manager.close();
  });

  it("clamps derived lease durations to the public timer-safe maximum", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: {
            interval: "0s",
            debounceMs: 0,
            onBoot: false,
            updateTimeoutMs: MAX_TIMER_TIMEOUT_MS,
            embedTimeoutMs: MAX_TIMER_TIMEOUT_MS,
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const { manager } = await createManager({ mode: "status" });
    withLeaseMock.mockClear();
    await manager.sync({ reason: "manual", force: true });

    expect(withLeaseMock).toHaveBeenCalled();
    for (const [options] of withLeaseMock.mock.calls as LeaseCall[]) {
      expect(options.leaseMs).toBeLessThanOrEqual(MAX_TIMER_TIMEOUT_MS);
      expect(options.waitMs).toBeLessThanOrEqual(MAX_TIMER_TIMEOUT_MS);
    }
    await manager.close();
  });

  it("preserves update and embed intent when the write lease fails after the callback", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    const { manager } = await createManager({ mode: "status" });
    (manager as unknown as { dirty: boolean }).dirty = true;
    (manager as unknown as { lastEmbedAt: number | null }).lastEmbedAt = Date.now();
    let rejectAfterCallback = true;
    const leaseLost = new PluginStateLeaseError("write lease lost", {
      code: "PLUGIN_STATE_LEASE_LOST",
    });
    withLeaseMock.mockImplementation(
      async <T>(
        options: PluginStateLeaseOptions,
        run: (lease: PluginStateLeaseContext) => Promise<T>,
      ) => {
        const result = await run({
          signal: options.signal ?? new AbortController().signal,
          assertOwned: vi.fn(),
        });
        if (rejectAfterCallback && options.database.scope === "agent") {
          throw leaseLost;
        }
        return result as T;
      },
    );

    await expect(manager.sync({ reason: "manual", force: true })).rejects.toBe(leaseLost);
    expect(manager.status().dirty).toBe(true);
    expect(
      (manager.status() as { custom?: { qmd?: { lastUpdateAt?: number | null } } }).custom?.qmd
        ?.lastUpdateAt,
    ).toBeNull();
    expect(countQmdCommand((args) => args[0] === "update")).toBe(1);

    rejectAfterCallback = false;
    await manager.sync({ reason: "retry" });
    expect(manager.status().dirty).toBe(false);
    expect(
      (manager.status() as { custom?: { qmd?: { lastUpdateAt?: number | null } } }).custom?.qmd
        ?.lastUpdateAt,
    ).toEqual(expect.any(Number));
    expect(countQmdCommand((args) => args[0] === "update")).toBe(2);
    expect(countQmdCommand((args) => args[0] === "embed")).toBe(1);
    await manager.close();
  });

  it("aborts collection reconciliation when its write lease is lost", async () => {
    await configureMemoryCoreDreamingStateForTests();
    const leaseController = new AbortController();
    const leaseLost = new PluginStateLeaseError("reconciliation lease lost", {
      code: "PLUGIN_STATE_LEASE_LOST",
    });
    let listKill: ReturnType<typeof vi.fn> | undefined;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        const kill = vi.fn(() => queueMicrotask(() => child.emit("close", null)));
        Object.assign(child, { kill });
        listKill = kill;
        return child;
      }
      return createMockChild();
    });
    withLeaseMock.mockImplementation(
      async <T>(
        options: PluginStateLeaseOptions,
        run: (lease: PluginStateLeaseContext) => Promise<T>,
      ) => {
        const signal = options.signal
          ? AbortSignal.any([options.signal, leaseController.signal])
          : leaseController.signal;
        return (await run({
          signal,
          assertOwned: () => signal.throwIfAborted(),
        })) as T;
      },
    );

    const creating = createManager({ mode: "cli" });
    creating.catch(() => undefined);
    await waitUntil(() => listKill !== undefined);
    leaseController.abort(leaseLost);

    await expect(creating).rejects.toBe(leaseLost);
    expect(listKill).toHaveBeenCalledWith("SIGKILL");
    expect(countQmdCommand((args) => args[0] === "collection" && args[1] === "add")).toBe(0);
  });

  it("aborts an in-flight qmd update when its write lease is lost", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    const { manager } = await createManager({ mode: "status" });
    const leaseController = new AbortController();
    const leaseLost = new PluginStateLeaseError("update lease lost", {
      code: "PLUGIN_STATE_LEASE_LOST",
    });
    let updateKill: ReturnType<typeof vi.fn> | undefined;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        const child = createMockChild({ autoClose: false });
        const kill = vi.fn(() => queueMicrotask(() => child.emit("close", null)));
        Object.assign(child, { kill });
        updateKill = kill;
        return child;
      }
      return createMockChild();
    });
    withLeaseMock.mockImplementation(
      async <T>(
        options: PluginStateLeaseOptions,
        run: (lease: PluginStateLeaseContext) => Promise<T>,
      ) => {
        const signal = options.signal
          ? AbortSignal.any([options.signal, leaseController.signal])
          : leaseController.signal;
        return (await run({
          signal,
          assertOwned: () => signal.throwIfAborted(),
        })) as T;
      },
    );

    const syncing = manager.sync({ reason: "manual", force: true });
    syncing.catch(() => undefined);
    await waitUntil(() => updateKill !== undefined);
    leaseController.abort(leaseLost);

    await expect(syncing).rejects.toBe(leaseLost);
    expect(updateKill).toHaveBeenCalledWith("SIGKILL");
    expect(
      (manager.status() as { custom?: { qmd?: { lastUpdateAt?: number | null } } }).custom?.qmd
        ?.lastUpdateAt,
    ).toBeNull();
    await manager.close();
  });

  it.each(["shared", "agent"] as const)(
    "fails closed when the %s embed lease is lost",
    async (lostScope) => {
      cfg = {
        ...cfg,
        memory: {
          backend: "qmd",
          qmd: {
            includeDefaultMemory: false,
            searchMode: "query",
            update: { interval: "0s", debounceMs: 0, onBoot: false },
            paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          },
        },
      } as OpenClawConfig;
      const { manager } = await createManager({ mode: "status" });
      // A forced sync must retain explicit embed intent after lease loss even
      // when the normal embed interval would consider a recent embed fresh.
      (manager as unknown as { lastEmbedAt: number | null }).lastEmbedAt = Date.now();
      const leaseLost = new PluginStateLeaseError(`${lostScope} embed lease lost`, {
        code: "PLUGIN_STATE_LEASE_LOST",
      });
      let embedPhase = false;
      let targetController: AbortController | undefined;
      let embedKill: ReturnType<typeof vi.fn> | undefined;
      spawnMock.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === "embed") {
          const child = createMockChild({ autoClose: false });
          const kill = vi.fn(() => queueMicrotask(() => child.emit("close", null)));
          Object.assign(child, { kill });
          embedKill = kill;
          return child;
        }
        return createMockChild();
      });
      withLeaseMock.mockImplementation(
        async <T>(
          options: PluginStateLeaseOptions,
          run: (lease: PluginStateLeaseContext) => Promise<T>,
        ) => {
          const isSharedEmbed = options.database.scope === "shared" && options.key === "embed";
          if (isSharedEmbed) {
            embedPhase = true;
          }
          const isTarget = lostScope === "shared" ? isSharedEmbed : embedPhase && !isSharedEmbed;
          const controller = isTarget ? new AbortController() : undefined;
          if (controller) {
            targetController = controller;
          }
          const signals = [options.signal, controller?.signal].filter(
            (signal): signal is AbortSignal => signal !== undefined,
          );
          const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]!;
          return (await run({
            signal,
            assertOwned: () => signal.throwIfAborted(),
          })) as T;
        },
      );

      const syncing = manager.sync({ reason: "manual", force: true });
      syncing.catch(() => undefined);
      await waitUntil(() => embedKill !== undefined && targetController !== undefined);
      targetController?.abort(leaseLost);

      await expect(syncing).rejects.toBe(leaseLost);
      expect(embedKill).toHaveBeenCalledWith("SIGKILL");
      expect(manager.status().dirty).toBe(true);
      expect(
        (manager.status() as { custom?: { qmd?: { lastUpdateAt?: number | null } } }).custom?.qmd
          ?.lastUpdateAt,
      ).toBeNull();

      spawnMock.mockImplementation(() => createMockChild());
      withLeaseMock.mockImplementation(
        async <T>(
          options: PluginStateLeaseOptions,
          run: (lease: PluginStateLeaseContext) => Promise<T>,
        ) =>
          await run({
            signal: options.signal ?? new AbortController().signal,
            assertOwned: vi.fn(),
          }),
      );
      await expect(manager.sync({ reason: "retry" })).resolves.toBeUndefined();
      expect(countQmdCommand((args) => args[0] === "embed")).toBe(2);
      expect(manager.status().dirty).toBe(false);
      await manager.close();
    },
  );

  it("does not hold the per-agent write lease while waiting for embed capacity", async () => {
    cfg = {
      ...cfg,
      agents: {
        ...cfg.agents,
        list: [
          { id: agentId, default: true, workspace: workspaceDir },
          { id: "other", workspace: workspaceDir },
        ],
      },
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    spawnMock.mockImplementation(() => createMockChild());

    let releaseFirstEmbed!: () => void;
    const firstEmbedLocked = new Promise<void>((resolve) => {
      withLeaseMock.mockImplementation(
        async <T>(
          options: PluginStateLeaseOptions,
          run: (lease: PluginStateLeaseContext) => Promise<T>,
        ) => {
          if (options.database.scope === "shared" && !releaseFirstEmbed) {
            resolve();
            await new Promise<void>((release) => {
              releaseFirstEmbed = release;
            });
          }
          return await run({
            signal: options.signal ?? new AbortController().signal,
            assertOwned: vi.fn(),
          });
        },
      );
    });

    const first = await createManager({ mode: "status" });
    const second = await createManager({ mode: "status", agentId: "other" });
    withLeaseMock.mockClear();
    const firstSync = first.manager.sync({ reason: "manual", force: true });
    await firstEmbedLocked;

    const secondSync = second.manager.sync({ reason: "manual", force: true });
    try {
      await waitUntil(() => writeLeaseCalls().length >= 2);

      // The second manager may run its update, but its embed must not take a store
      // write lease while it is still queued behind the first embed.
      expect(writeLeaseCalls().length).toBe(2);
    } finally {
      releaseFirstEmbed();
    }

    await Promise.all([firstSync, secondSync]);
    expect(writeLeaseCalls().length).toBeGreaterThanOrEqual(4);

    await first.manager.close();
    await second.manager.close();
  });

  it("serializes session exports across managers for the same agent", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          sessions: { enabled: true },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const sessionsDir = path.join(stateDir, "agents", agentId, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionsDir, "session-1.jsonl"),
      '{"type":"message","message":{"role":"user","content":"hello"}}\n',
      "utf-8",
    );

    const firstEntered = createDeferred<void>();
    const releaseFirst = createDeferred<void>();
    let activeExports = 0;
    let overlapped = false;
    const exportSpy = vi
      .spyOn(
        QmdMemoryManager.prototype as unknown as {
          exportSessions: (lease: {
            signal: AbortSignal;
            assertOwned: () => void;
          }) => Promise<void>;
        },
        "exportSessions",
      )
      .mockImplementation(async (_signal) => {
        activeExports += 1;
        if (activeExports > 1) {
          overlapped = true;
        }
        if (activeExports === 1) {
          firstEntered.resolve();
          await releaseFirst.promise;
        }
        activeExports -= 1;
      });

    const first = await createManager({ mode: "status" });
    const second = await createManager({ mode: "status" });

    try {
      const firstSync = first.manager.sync({ reason: "manual", force: true });
      await firstEntered.promise;

      const secondSync = second.manager.sync({ reason: "manual", force: true });
      await Promise.resolve();

      expect(exportSpy).toHaveBeenCalledTimes(1);
      expect(overlapped).toBe(false);

      releaseFirst.resolve();
      await Promise.all([firstSync, secondSync]);

      expect(exportSpy).toHaveBeenCalledTimes(2);
      expect(overlapped).toBe(false);
    } finally {
      exportSpy.mockRestore();
      await first.manager.close();
      await second.manager.close();
    }
  });

  it("maps exported QMD artifacts to the persisted session identity", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          sessions: { enabled: true },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    await seedQmdSessionTranscript({
      agentId,
      content: "hello mapped session",
      sessionId: "actual-session",
      stateDir,
      sessionKey: "agent:main:chat:thread",
    });

    const { manager } = await createManager({ mode: "status" });
    await (
      manager as unknown as {
        exportSessions: (lease: { signal: AbortSignal; assertOwned: () => void }) => Promise<void>;
      }
    ).exportSessions({ signal: new AbortController().signal, assertOwned: vi.fn() });
    const indexPath = (manager as unknown as { indexPath: string }).indexPath;
    const identity = resolveQmdSessionArtifactIdentity({
      artifactPath: "actual-session.md",
      collection: "sessions-main",
      indexPath,
      searchPath: "qmd/sessions-main/actual-session.md",
    });

    expect(identity).toEqual({
      agentId,
      archived: false,
      memoryKey: formatSessionTranscriptMemoryHitKey({
        agentId,
        sessionId: "actual-session",
      }),
      sessionId: "actual-session",
    });

    await manager.close();
  });

  it("does not publish session artifact mappings after lease ownership is lost", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          sessions: { enabled: true },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    await seedQmdSessionTranscript({
      agentId,
      content: "lease guarded session",
      sessionId: "lease-guarded-session",
      stateDir,
      sessionKey: "agent:main:chat:lease-guarded",
    });
    const { manager } = await createManager({ mode: "status" });
    const leaseLost = new PluginStateLeaseError("session export lease lost", {
      code: "PLUGIN_STATE_LEASE_LOST",
    });
    let ownershipChecks = 0;

    await expect(
      (
        manager as unknown as {
          exportSessions: (lease: {
            signal: AbortSignal;
            assertOwned: () => void;
          }) => Promise<void>;
        }
      ).exportSessions({
        signal: new AbortController().signal,
        assertOwned: () => {
          ownershipChecks += 1;
          if (ownershipChecks === 3) {
            throw leaseLost;
          }
        },
      }),
    ).rejects.toBe(leaseLost);

    const indexPath = (manager as unknown as { indexPath: string }).indexPath;
    expect(
      resolveQmdSessionArtifactIdentity({
        artifactPath: "lease-guarded-session.md",
        collection: "sessions-main",
        indexPath,
        searchPath: "qmd/sessions-main/lease-guarded-session.md",
      }),
    ).toBeNull();
    await manager.close();
  });

  it("skips queued session export work after close while waiting on the shared update queue", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          sessions: { enabled: true },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const sessionsDir = path.join(stateDir, "agents", agentId, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionsDir, "session-1.jsonl"),
      '{"type":"message","message":{"role":"user","content":"hello"}}\n',
      "utf-8",
    );

    const firstEntered = createDeferred<void>();
    const releaseFirst = createDeferred<void>();
    const exportSpy = vi
      .spyOn(
        QmdMemoryManager.prototype as unknown as {
          exportSessions: (lease: {
            signal: AbortSignal;
            assertOwned: () => void;
          }) => Promise<void>;
        },
        "exportSessions",
      )
      .mockImplementation(async (_signal) => {
        if (exportSpy.mock.calls.length === 1) {
          firstEntered.resolve();
          await releaseFirst.promise;
        }
      });

    const first = await createManager({ mode: "status" });
    const second = await createManager({ mode: "status" });

    try {
      const firstSync = first.manager.sync({ reason: "manual", force: true });
      await firstEntered.promise;

      const secondSync = second.manager.sync({ reason: "manual", force: true });
      await Promise.resolve();

      const closeSecond = second.manager.close();
      await expect(closeSecond).resolves.toBeUndefined();

      releaseFirst.resolve();
      await Promise.all([firstSync, secondSync]);

      expect(exportSpy).toHaveBeenCalledTimes(1);
      const updateCalls = spawnMock.mock.calls
        .map((call: unknown[]) => call[1] as string[])
        .filter((args: string[]) => args[0] === "update");
      expect(updateCalls).toHaveLength(1);
    } finally {
      exportSpy.mockRestore();
      await first.manager.close();
      await second.manager.close();
    }
  });

  it("skips qmd embed in lexical search mode for forced sync", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const { manager } = await createManager({ mode: "status" });
    await manager.sync({ reason: "manual", force: true });

    const commandCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "update" || args[0] === "embed");
    expect(commandCalls).toEqual([["update"]]);
    await manager.close();
  });

  it("retries boot update when qmd reports a retryable lock error", async () => {
    vi.useFakeTimers();
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          update: {
            interval: "0s",
            debounceMs: 60_000,
            onBoot: true,
            waitForBootSync: true,
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    let updateCalls = 0;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        updateCalls += 1;
        const child = createMockChild({ autoClose: false });
        if (updateCalls === 1) {
          emitAndClose(child, "stderr", "SQLITE_BUSY: database is locked", 2);
        } else {
          emitAndClose(child, "stdout", "", 0);
        }
        return child;
      }
      return createMockChild();
    });

    const managerPromise = createManager({ mode: "full" });
    await waitUntil(() => updateCalls === 1);
    await vi.advanceTimersByTimeAsync(500);
    await waitUntil(() => updateCalls === 2);
    const { manager } = await managerPromise;

    expect(updateCalls).toBe(2);
    await manager.close();
  });

  it("succeeds on qmd update even when stdout exceeds the output cap", async () => {
    // Regression test for #24966: large indexes produce >200K chars of stdout
    // during `qmd update`, which used to fail with "produced too much output".
    const largeOutput = "x".repeat(300_000);
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", largeOutput);
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "status" });
    // sync triggers runQmdUpdateOnce -> runQmd(["update"], { discardOutput: true })
    await expect(manager.sync({ reason: "manual" })).resolves.toBeUndefined();
    await manager.close();
  });

  it("scopes by channel for agent-prefixed session keys", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          scope: {
            default: "deny",
            rules: [{ action: "allow", match: { channel: "slack" } }],
          },
        },
      },
    } as OpenClawConfig;
    const { manager } = await createManager();

    const isAllowed = (key?: string) =>
      (manager as unknown as { isScopeAllowed: (key?: string) => boolean }).isScopeAllowed(key);
    expect(isAllowed("agent:main:slack:channel:c123")).toBe(true);
    expect(isAllowed("agent:main:slack:direct:u123")).toBe(true);
    expect(isAllowed("agent:main:slack:dm:u123")).toBe(true);
    expect(isAllowed("agent:main:discord:direct:u123")).toBe(false);
    expect(isAllowed("agent:main:discord:channel:c123")).toBe(false);

    await manager.close();
  });

  it("logs when qmd scope denies search", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          scope: {
            default: "deny",
            rules: [{ action: "allow", match: { chatType: "direct" } }],
          },
        },
      },
    } as OpenClawConfig;
    const { manager } = await createManager();

    logWarnMock.mockClear();
    const beforeCalls = spawnMock.mock.calls.length;
    await expect(
      manager.search("blocked", { sessionKey: "agent:main:discord:channel:c123" }),
    ).resolves.toStrictEqual([]);

    expect(spawnMock.mock.calls.length).toBe(beforeCalls);
    expectMockMessageContains(logWarnMock, "qmd search denied by scope");
    expectMockMessageContains(logWarnMock, "chatType=channel");

    await manager.close();
  });

  it("blocks non-markdown or symlink reads for qmd paths", async () => {
    const { manager } = await createManager();

    const textPath = path.join(workspaceDir, "secret.txt");
    await fs.writeFile(textPath, "nope", "utf-8");
    await expect(manager.readFile({ relPath: "qmd/workspace-main/secret.txt" })).rejects.toThrow(
      "path required",
    );

    const target = path.join(workspaceDir, "target.md");
    await fs.writeFile(target, "ok", "utf-8");
    const link = path.join(workspaceDir, "link.md");
    await fs.symlink(target, link);
    await expect(manager.readFile({ relPath: "qmd/workspace-main/link.md" })).rejects.toThrow(
      "path required",
    );

    await manager.close();
  });

  it("blocks memory_get reads of remember-only session exports", async () => {
    cfg = {
      ...cfg,
      agents: {
        ...cfg.agents,
        list: [{ id: "main", memorySearch: { rememberAcrossConversations: true } }],
      },
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    const { manager } = await createManager();

    // Remember-only export is search-only for trusted recall; ordinary
    // memory_get must not read transcript exports the operator never opted into.
    await expect(manager.readFile({ relPath: "qmd/sessions-main/export.md" })).rejects.toThrow(
      "path required",
    );

    await manager.close();
  });

  it("keeps explicitly configured session exports readable via memory_get", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          sessions: { enabled: true },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    const { manager } = await createManager();

    await expect(manager.readFile({ relPath: "qmd/sessions-main/export.md" })).resolves.toEqual({
      path: "qmd/sessions-main/export.md",
      text: "",
    });

    await manager.close();
  });

  it("rejects non-memory workspace markdown reads", async () => {
    await fs.writeFile(path.join(workspaceDir, "window.md"), "secret", "utf-8");
    await fs.mkdir(path.join(workspaceDir, ".memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, ".memory", "hidden.md"), "secret", "utf-8");

    const { manager } = await createManager();

    await expect(manager.readFile({ relPath: "window.md" })).rejects.toThrow("path required");
    await expect(manager.readFile({ relPath: ".memory/hidden.md" })).rejects.toThrow(
      "path required",
    );

    await manager.close();
  });

  it("reads only requested line ranges from canonical memory files without loading the whole file", async () => {
    const readFileSpy = vi.spyOn(fs, "readFile");
    const text = Array.from({ length: 50 }, (_, index) => `line-${index + 1}`).join("\n");
    const relPath = path.join("memory", "window.md");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, relPath), text, "utf-8");

    const { manager } = await createManager();

    const result = await manager.readFile({ relPath, from: 10, lines: 3 });
    expect(result).toEqual({
      path: relPath,
      text: "line-10\nline-11\nline-12\n\n[More content available. Use from=13 to continue.]",
      from: 10,
      lines: 3,
      truncated: true,
      nextFrom: 13,
    });
    expect(readFileSpy).not.toHaveBeenCalled();

    await manager.close();
    readFileSpy.mockRestore();
  });

  it("defaults non-finite partial read line options before streaming canonical memory files", async () => {
    const readFileSpy = vi.spyOn(fs, "readFile");
    const relPath = path.join("memory", "non-finite-window.md");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, relPath),
      ["line-1", "line-2", "line-3"].join("\n"),
      "utf-8",
    );

    const { manager } = await createManager();

    const result = await manager.readFile({
      relPath,
      from: Number.NaN,
      lines: Number.POSITIVE_INFINITY,
    });
    expect(result).toEqual({
      path: relPath,
      text: "line-1\nline-2\nline-3",
      from: 1,
      lines: 3,
    });
    expect(readFileSpy).not.toHaveBeenCalled();

    await manager.close();
    readFileSpy.mockRestore();
  });

  it("returns a bounded default excerpt for qmd memory reads without explicit lines", async () => {
    const relPath = path.join("memory", "default-window.md");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, relPath),
      Array.from({ length: 150 }, (_, index) => `line-${index + 1}`).join("\n"),
      "utf-8",
    );

    const { manager } = await createManager();

    const result = await manager.readFile({ relPath });
    expect(result.path).toBe(relPath);
    expect(result.from).toBe(1);
    expect(result.lines).toBe(120);
    expect(result.truncated).toBe(true);
    expect(result.nextFrom).toBe(121);
    expect(result.text).toContain("line-1");
    expect(result.text).toContain("line-120");
    expect(result.text).not.toContain("line-121");
    expect(result.text).toContain("Use from=121 to continue.");

    await manager.close();
  });

  it("returns empty text when qmd files are missing before or during read", async () => {
    const relPath = path.join("memory", "qmd-window.md");
    const absPath = path.join(workspaceDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, "one\ntwo\nthree", "utf-8");

    const cases = [
      {
        name: "missing before read",
        request: { relPath: path.join("memory", "ghost.md") },
        expectedPath: path.join("memory", "ghost.md"),
      },
      {
        name: "disappears before partial read",
        request: { relPath, from: 2, lines: 1 },
        expectedPath: relPath,
        installOpenSpy: () => {
          const realOpen = fs.open;
          let injected = false;
          const openSpy = vi
            .spyOn(fs, "open")
            .mockImplementation(async (...args: Parameters<typeof realOpen>) => {
              const [target, options] = args;
              if (!injected && typeof target === "string" && path.resolve(target) === absPath) {
                injected = true;
                const err = new Error("gone") as NodeJS.ErrnoException;
                err.code = "ENOENT";
                throw err;
              }
              return await realOpen(target, options);
            });
          return () => openSpy.mockRestore();
        },
      },
    ] as const;

    for (const testCase of cases) {
      const { manager } = await createManager();
      const restoreOpen = "installOpenSpy" in testCase ? testCase.installOpenSpy() : undefined;
      try {
        const result = await manager.readFile(testCase.request);
        expect(result, testCase.name).toEqual({ text: "", path: testCase.expectedPath });
      } finally {
        restoreOpen?.();
        await manager.close();
      }
    }
  });

  it("reuses exported session markdown files when inputs are unchanged", async () => {
    const exportFile = path.join(stateDir, "agents", agentId, "qmd", "sessions", "session-1.md");
    await seedQmdSessionTranscript({ agentId, content: "hello", sessionId: "session-1", stateDir });

    const currentMemory = cfg.memory;
    cfg = {
      ...cfg,
      memory: {
        ...currentMemory,
        qmd: {
          ...currentMemory?.qmd,
          sessions: {
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;

    const { manager } = await createManager();

    try {
      await manager.sync({ reason: "manual" });
      const firstExport = await fs.readFile(exportFile, "utf-8");
      expect(firstExport).toContain("hello");

      await manager.sync({ reason: "manual" });
      const secondExport = await fs.readFile(exportFile, "utf-8");
      expect(secondExport).toBe(firstExport);
    } finally {
      await manager.close();
    }
  });

  it("fails closed when sqlite index is busy during doc lookup or search", async () => {
    const cases = [
      {
        name: "resolveDocLocation",
        run: async (manager: QmdMemoryManager) => {
          const inner = manager as unknown as {
            db: {
              prepare: () => {
                all: () => never;
                get: () => never;
              };
              close: () => void;
            } | null;
            resolveDocLocation: (docid?: string) => Promise<unknown>;
          };
          const busyStmt: { all: () => never; get: () => never } = {
            all: () => {
              throw new Error("SQLITE_BUSY: database is locked");
            },
            get: () => {
              throw new Error("SQLITE_BUSY: database is locked");
            },
          };
          inner.db = {
            prepare: () => busyStmt,
            close: () => {},
          };
          await expect(inner.resolveDocLocation("abc123")).rejects.toThrow(
            "qmd index busy while reading results",
          );
        },
      },
      {
        name: "search",
        run: async (manager: QmdMemoryManager) => {
          spawnMock.mockImplementation((_cmd: string, args: string[]) => {
            if (args[0] === "search") {
              const child = createMockChild({ autoClose: false });
              emitAndClose(
                child,
                "stdout",
                JSON.stringify([{ docid: "abc123", score: 1, snippet: "@@ -1,1\nremember this" }]),
              );
              return child;
            }
            return createMockChild();
          });
          const inner = manager as unknown as {
            db: { prepare: () => { all: () => never }; close: () => void } | null;
          };
          inner.db = {
            prepare: () => ({
              all: () => {
                throw new Error("SQLITE_BUSY: database is locked");
              },
            }),
            close: () => {},
          };
          await expect(
            manager.search("busy lookup", { sessionKey: "agent:main:slack:dm:u123" }),
          ).rejects.toThrow("qmd index busy while reading results");
        },
      },
    ] as const;

    for (const testCase of cases) {
      spawnMock.mockClear();
      spawnMock.mockImplementation(() => createMockChild());
      const { manager } = await createManager();
      try {
        await testCase.run(manager);
      } catch (error) {
        throw new Error(
          `${testCase.name}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      } finally {
        await manager.close();
      }
    }
  });

  it("prefers exact docid match before prefix fallback for qmd document lookups", async () => {
    const prepareCalls: string[] = [];
    const exactDocid = "abc123";
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([
            { docid: exactDocid, score: 1, snippet: "@@ -5,2\nremember this\nnext line" },
          ]),
        );
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    const inner = manager as unknown as {
      db: { prepare: (query: string) => { all: (arg: unknown) => unknown }; close: () => void };
    };
    inner.db = {
      prepare: (query: string) => {
        prepareCalls.push(query);
        return {
          all: (arg: unknown) => {
            if (query.includes("hash = ?")) {
              return [];
            }
            if (query.includes("hash LIKE ?")) {
              expect(arg).toBe(`${exactDocid}%`);
              return [{ collection: "workspace-main", path: "notes/welcome.md" }];
            }
            throw new Error(`unexpected sqlite query: ${query}`);
          },
        };
      },
      close: () => {},
    };

    const results = await manager.search("test", { sessionKey: "agent:main:slack:dm:u123" });
    expect(results).toEqual([
      {
        path: "notes/welcome.md",
        startLine: 5,
        endLine: 6,
        score: 1,
        snippet: "@@ -5,2\nremember this\nnext line",
        source: "memory",
      },
    ]);

    expect(prepareCalls).toHaveLength(2);
    expect(prepareCalls[0]).toContain("hash = ?");
    expect(prepareCalls[1]).toContain("hash LIKE ?");
    await manager.close();
  });

  it("prefers collection hint when resolving duplicate qmd document hashes", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [
            { path: workspaceDir, pattern: "**/*.md", name: "workspace" },
            { path: path.join(workspaceDir, "notes"), pattern: "**/*.md", name: "notes" },
          ],
        },
      },
    } as OpenClawConfig;

    const duplicateDocid = "dup-123";
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search" && args.includes("workspace-main")) {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([
            { docid: duplicateDocid, score: 0.9, snippet: "@@ -3,1\nworkspace hit" },
          ]),
        );
        return child;
      }
      if (args[0] === "search" && args.includes("notes-main")) {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();
    const inner = manager as unknown as {
      db: { prepare: (query: string) => { all: (arg: unknown) => unknown }; close: () => void };
    };
    inner.db = {
      prepare: (_query: string) => ({
        all: (arg: unknown) => {
          if (typeof arg === "string" && arg.startsWith(duplicateDocid)) {
            return [
              { collection: "stale-workspace", path: "notes/welcome.md" },
              { collection: "workspace-main", path: "notes/welcome.md" },
            ];
          }
          return [];
        },
      }),
      close: () => {},
    };

    const results = await manager.search("workspace", { sessionKey: "agent:main:slack:dm:u123" });
    expect(results).toEqual([
      {
        path: "notes/welcome.md",
        startLine: 3,
        endLine: 3,
        score: 0.9,
        snippet: "@@ -3,1\nworkspace hit",
        source: "memory",
      },
    ]);
    await manager.close();
  });

  it("resolves search hits when qmd returns qmd:// file URIs without docid", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([
            {
              file: "qmd://workspace-main/notes/welcome.md",
              score: 0.71,
              snippet: "@@ -4,1\ntoken unlock",
            },
          ]),
        );
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    const results = await manager.search("token unlock", {
      sessionKey: "agent:main:slack:dm:u123",
    });
    expect(results).toEqual([
      {
        path: "notes/welcome.md",
        startLine: 4,
        endLine: 4,
        score: 0.71,
        snippet: "@@ -4,1\ntoken unlock",
        source: "memory",
      },
    ]);
    await manager.close();
  });

  it("returns collection-scoped qmd paths when session exports live under the workspace qmd directory", async () => {
    workspaceDir = path.join(stateDir, "agents", agentId);
    await fs.mkdir(workspaceDir, { recursive: true });
    cfg = {
      agents: {
        list: [{ id: agentId, default: true, workspace: workspaceDir }],
      },
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          sessions: { enabled: true },
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([
            {
              file: "qmd://sessions-main/session-1.md",
              score: 0.84,
              snippet: "@@ -2,1\nsession canary",
            },
          ]),
        );
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    const inner = manager as unknown as {
      collectionRoots: Map<string, { path: string }>;
      resolveReadPath: (relPath: string) => string;
    };
    const sessionRoot = requireValue(
      inner.collectionRoots.get("sessions-main"),
      "sessions collection root missing",
    );
    expect(sessionRoot.path).toContain(path.join("qmd", "sessions"));
    const exportedSessionPath = path.join(sessionRoot.path, "session-1.md");

    const results = await manager.search("session canary", {
      sessionKey: "agent:main:slack:dm:u123",
    });
    expect(results).toEqual([
      {
        path: "qmd/sessions-main/session-1.md",
        startLine: 2,
        endLine: 2,
        score: 0.84,
        snippet: "@@ -2,1\nsession canary",
        source: "sessions",
      },
    ]);

    const result = expectDefined(results[0], "QMD session search result");
    expect(inner.resolveReadPath(result.path)).toBe(exportedSessionPath);
    const realLstat = fs.lstat;
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (target, options) => {
      if (typeof target === "string" && path.resolve(target) === exportedSessionPath) {
        return {
          isFile: () => true,
          isSymbolicLink: () => false,
        } as Awaited<ReturnType<typeof realLstat>>;
      }
      return await realLstat(target, options);
    });
    const realReadFile = fs.readFile;
    const readSpy = vi.spyOn(fs, "readFile").mockImplementation(async (target, options) => {
      if (typeof target === "string" && path.resolve(target) === exportedSessionPath) {
        return "# Session session-1\n\nsession canary\n";
      }
      return await realReadFile(target, options as never);
    });

    try {
      const readResult = await manager.readFile({ relPath: result.path });
      expect(readResult).toEqual({
        path: "qmd/sessions-main/session-1.md",
        text: "# Session session-1\n\nsession canary\n",
        from: 1,
        lines: 4,
      });
    } finally {
      lstatSpy.mockRestore();
      readSpy.mockRestore();
    }

    await manager.close();
  });

  it("restricts qmd search to session collections before result limiting", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          sessions: { enabled: true },
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search" && args.includes("workspace-main")) {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([
            {
              file: "qmd://workspace-main/notes.md",
              score: 0.99,
              snippet: "@@ -1,1\nmemory hit",
            },
          ]),
        );
        return child;
      }
      if (args[0] === "search" && args.includes("sessions-main")) {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([
            {
              file: "qmd://sessions-main/session-1.md",
              score: 0.8,
              snippet: "@@ -2,1\nsession hit",
            },
          ]),
        );
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    const results = await manager.search("hit", {
      sessionKey: "agent:main:slack:dm:u123",
      sources: ["sessions"],
      maxResults: 1,
    });

    expect(results).toEqual([
      {
        path: "qmd/sessions-main/session-1.md",
        startLine: 2,
        endLine: 2,
        score: 0.8,
        snippet: "@@ -2,1\nsession hit",
        source: "sessions",
      },
    ]);

    const searchCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args) => args[0] === "search");
    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0]).toContain("sessions-main");
    expect(searchCalls[0]).not.toContain("workspace-main");

    await manager.close();
  });

  it("preserves multi-collection qmd search hits when results only include file URIs", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [
            { path: workspaceDir, pattern: "**/*.md", name: "workspace" },
            { path: path.join(workspaceDir, "notes"), pattern: "**/*.md", name: "notes" },
          ],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search" && args.includes("workspace-main")) {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([
            {
              file: "qmd://workspace-main/memory/facts.md",
              score: 0.8,
              snippet: "@@ -2,1\nworkspace fact",
            },
          ]),
        );
        return child;
      }
      if (args[0] === "search" && args.includes("notes-main")) {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([
            {
              file: "qmd://notes-main/guide.md",
              score: 0.7,
              snippet: "@@ -1,1\nnotes guide",
            },
          ]),
        );
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    const results = await manager.search("fact", {
      sessionKey: "agent:main:slack:dm:u123",
    });
    expect(results).toEqual([
      {
        path: "memory/facts.md",
        startLine: 2,
        endLine: 2,
        score: 0.8,
        snippet: "@@ -2,1\nworkspace fact",
        source: "memory",
      },
      {
        path: "notes/guide.md",
        startLine: 1,
        endLine: 1,
        score: 0.7,
        snippet: "@@ -1,1\nnotes guide",
        source: "memory",
      },
    ]);
    await manager.close();
  });

  it("errors when qmd output exceeds command output safety cap", async () => {
    const noisyPayload = "x".repeat(240_000);
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", noisyPayload);
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    await expect(
      manager.search("noise", { sessionKey: "agent:main:slack:dm:u123" }),
    ).rejects.toThrow(/too much output/);
    await manager.close();
  });

  it("treats plain-text no-results markers from stdout/stderr as empty result sets", async () => {
    const cases = [
      { name: "stdout with punctuation", stream: "stdout", payload: "No results found." },
      { name: "stdout without punctuation", stream: "stdout", payload: "No results found\n\n" },
      { name: "stderr", stream: "stderr", payload: "No results found.\n" },
    ] as const;

    for (const testCase of cases) {
      spawnMock.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === "search") {
          const child = createMockChild({ autoClose: false });
          emitAndClose(child, testCase.stream, testCase.payload);
          return child;
        }
        return createMockChild();
      });

      const { manager } = await createManager();
      await expect(
        manager.search("missing", { sessionKey: "agent:main:slack:dm:u123" }),
        testCase.name,
      ).resolves.toStrictEqual([]);
      await manager.close();
    }
  });

  it("throws when stdout is empty without the no-results marker", async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "query") {
        const child = createMockChild({ autoClose: false });
        queueMicrotask(() => {
          child.stdout.emit("data", "   \n");
          child.stderr.emit("data", "unexpected parser error");
          child.closeWith(0);
        });
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    await expect(
      manager.search("missing", { sessionKey: "agent:main:slack:dm:u123" }),
    ).rejects.toThrow(/qmd query returned invalid JSON/);
    await manager.close();
  });

  it("sets busy_timeout on qmd sqlite connections", async () => {
    const { manager } = await createManager();
    const indexPath = (manager as unknown as { indexPath: string }).indexPath;
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const seedDb = new DatabaseSync(indexPath);
    seedDb.close();

    const db = (manager as unknown as { ensureDb: () => DatabaseSync }).ensureDb();
    const row = db.prepare("PRAGMA busy_timeout").get() as
      | { busy_timeout?: number; timeout?: number }
      | undefined;
    const busyTimeout = row?.busy_timeout ?? row?.timeout;
    expect(busyTimeout).toBe(1000);
    await manager.close();
  });

  it("uses the configured qmd timeout for status probes", async () => {
    vi.useFakeTimers();
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          limits: { timeoutMs: 6000 },
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    let statusKill: Mock | null = null;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "status") {
        const child = createMockChild({ autoClose: false });
        statusKill = vi.fn();
        child.kill = statusKill;
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    const probe = manager.probeVectorAvailability();
    await vi.advanceTimersByTimeAsync(5000);
    expect(statusKill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(probe).resolves.toBe(false);
    expect(manager.status().vector).toEqual({
      enabled: true,
      available: false,
      semanticAvailable: false,
      loadError: expect.stringContaining("timed out after 6000ms"),
    });
    await manager.close();
  });

  it("exports valid session transcripts whose IDs contain checkpoint words", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          sessions: { enabled: true },
          update: {
            interval: "0s",
            debounceMs: 0,
            onBoot: true,
            waitForBootSync: true,
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    await seedQmdSessionTranscript({
      agentId,
      content: "live",
      sessionId: "live-session",
      stateDir,
    });
    await seedQmdSessionTranscript({
      agentId,
      content: "notes",
      sessionId: "team.checkpoint.notes",
      stateDir,
    });

    const { manager } = await createManager({ mode: "full" });
    const sessionExportDir = path.join(stateDir, "agents", agentId, "qmd", "sessions");
    const exported = (await fs.readdir(sessionExportDir)).toSorted();

    expect(exported).toEqual(["live-session.md", "team.checkpoint.notes.md"]);
    await expect(
      fs.readFile(path.join(sessionExportDir, "team.checkpoint.notes.md"), "utf-8"),
    ).resolves.toContain("notes");
    await manager.close();
  });

  it("reports vector availability as unavailable when qmd status shows zero vectors", async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "status") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "Documents: 12\nVectors: 0\n");
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({
      cfg: {
        ...cfg,
        memory: {
          ...cfg.memory,
          qmd: { ...cfg.memory?.qmd, searchMode: "query" },
        },
      } as OpenClawConfig,
    });

    await expect(manager.probeVectorAvailability()).resolves.toBe(false);
    await expect(manager.probeEmbeddingAvailability()).resolves.toEqual({
      ok: false,
      error: "QMD index has 0 vectors; semantic search is unavailable until embeddings finish",
    });
    expect(manager.status().vector).toEqual({
      enabled: true,
      available: false,
      semanticAvailable: false,
      loadError: "QMD index has 0 vectors; semantic search is unavailable until embeddings finish",
    });
    await manager.close();
  });

  it("reports vector availability as ready when qmd status shows vectors", async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "status") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "Documents: 12\nVectors: 42\n");
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({
      cfg: {
        ...cfg,
        memory: {
          ...cfg.memory,
          qmd: { ...cfg.memory?.qmd, searchMode: "query" },
        },
      } as OpenClawConfig,
    });

    await expect(manager.probeVectorAvailability()).resolves.toBe(true);
    await expect(manager.probeEmbeddingAvailability()).resolves.toEqual({
      ok: true,
      error: undefined,
    });
    expect(manager.status().vector).toEqual({
      enabled: true,
      available: true,
      semanticAvailable: true,
      loadError: undefined,
    });
    await manager.close();
  });

  it.each([
    ["equals separator", "Documents: 12\nVectors = 42\n"],
    ["tab separator", "Documents: 12\nVectors:\t42\n"],
    ["compact separator", "Documents: 12\nVectors:42\n"],
    ["embedded suffix", "Documents: 12\nVectors:  42 embedded\n"],
  ])("reports vector availability as ready for qmd status %s", async (_name, statusOutput) => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "status") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", statusOutput);
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({
      cfg: {
        ...cfg,
        memory: {
          ...cfg.memory,
          qmd: { ...cfg.memory?.qmd, searchMode: "query" },
        },
      } as OpenClawConfig,
    });

    await expect(manager.probeVectorAvailability()).resolves.toBe(true);
    await manager.close();
  });

  it("does not parse unrelated qmd status vector-like fields", async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "status") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "Documents: 12\nMaxVectors: 42\nVector index: yes\n");
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({
      cfg: {
        ...cfg,
        memory: {
          ...cfg.memory,
          qmd: { ...cfg.memory?.qmd, searchMode: "query" },
        },
      } as OpenClawConfig,
    });

    await expect(manager.probeVectorAvailability()).resolves.toBe(false);
    expect(manager.status().vector).toEqual({
      enabled: true,
      available: false,
      semanticAvailable: false,
      loadError: "Could not determine QMD vector status from `qmd status`",
    });
    await manager.close();
  });

  it("skips qmd status vector probes for lexical search mode", async () => {
    const { manager } = await createManager({
      cfg: {
        ...cfg,
        memory: {
          ...cfg.memory,
          qmd: { ...cfg.memory?.qmd, searchMode: "search" },
        },
      } as OpenClawConfig,
    });
    const baselineCalls = spawnMock.mock.calls.length;

    await expect(manager.probeVectorAvailability()).resolves.toBe(false);
    await expect(manager.probeEmbeddingAvailability()).resolves.toEqual({
      ok: true,
      checked: false,
    });
    expect(spawnMock.mock.calls.length).toBe(baselineCalls);
    expect(manager.status().vector).toEqual({
      enabled: false,
      available: false,
      semanticAvailable: false,
      loadError: undefined,
    });
    await manager.close();
  });

  describe("model cache symlink", () => {
    let defaultModelsDir: string;
    let customModelsDir: string;
    let savedXdgCacheHome: string | undefined;

    beforeEach(async () => {
      // Redirect XDG_CACHE_HOME so symlinkSharedModels finds our fake models
      // directory instead of the real ~/.cache.
      savedXdgCacheHome = process.env.XDG_CACHE_HOME;
      const fakeCacheHome = path.join(tmpRoot, "fake-cache");
      Reflect.set(process.env, "XDG_CACHE_HOME", fakeCacheHome);

      defaultModelsDir = path.join(fakeCacheHome, "qmd", "models");
      await fs.mkdir(defaultModelsDir, { recursive: true });
      await fs.writeFile(path.join(defaultModelsDir, "model.bin"), "fake-model");

      customModelsDir = path.join(stateDir, "agents", agentId, "qmd", "xdg-cache", "qmd", "models");
    });

    afterEach(() => {
      if (savedXdgCacheHome === undefined) {
        Reflect.deleteProperty(process.env, "XDG_CACHE_HOME");
      } else {
        Reflect.set(process.env, "XDG_CACHE_HOME", savedXdgCacheHome);
      }
    });

    it("handles first-run symlink, existing dir preservation, and missing default cache", async () => {
      const cases: Array<{
        name: string;
        setup?: () => Promise<void>;
        assert: () => Promise<void>;
      }> = [
        {
          name: "symlinks default cache on first run",
          assert: async () => {
            const stat = await fs.lstat(customModelsDir);
            expect(stat.isSymbolicLink()).toBe(true);
            const target = await fs.readlink(customModelsDir);
            expect(target).toBe(defaultModelsDir);
            const content = await fs.readFile(path.join(customModelsDir, "model.bin"), "utf-8");
            expect(content).toBe("fake-model");
          },
        },
        {
          name: "does not overwrite existing models directory",
          setup: async () => {
            await fs.mkdir(customModelsDir, { recursive: true });
            await fs.writeFile(path.join(customModelsDir, "custom-model.bin"), "custom");
          },
          assert: async () => {
            const stat = await fs.lstat(customModelsDir);
            expect(stat.isSymbolicLink()).toBe(false);
            expect(stat.isDirectory()).toBe(true);
            const content = await fs.readFile(
              path.join(customModelsDir, "custom-model.bin"),
              "utf-8",
            );
            expect(content).toBe("custom");
          },
        },
        {
          name: "skips symlink when default models are absent",
          setup: async () => {
            await fs.rm(defaultModelsDir, { recursive: true, force: true });
          },
          assert: async () => {
            await expectPathMissing(customModelsDir);
            expectMockMessageNotContains(logWarnMock, "failed to symlink qmd models directory");
          },
        },
      ];

      for (const testCase of cases) {
        await fs.rm(customModelsDir, { recursive: true, force: true });
        await fs.mkdir(defaultModelsDir, { recursive: true });
        await fs.writeFile(path.join(defaultModelsDir, "model.bin"), "fake-model");
        logWarnMock.mockClear();
        await testCase.setup?.();
        const { manager } = await createManager({ mode: "full" });
        try {
          await testCase.assert();
        } finally {
          await manager.close();
        }
      }
    });
  });

  it("rebinds a managed collection when its root path changed (show reveals old path)", async () => {
    // Regression: listCollectionsBestEffort gets only the name from `collection list`
    // (no path). The fix enriches path via `collection show`; without it shouldRebindCollection
    // hits the `!listed.path` branch and skips the rebind, leaving the old path pinned.
    const oldWorkspaceDir = path.join(tmpRoot, "old-workspace");
    const newWorkspaceDir = workspaceDir; // the manager is configured for this new path

    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: newWorkspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const collectionName = `workspace-${agentId}`;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        // Real qmd: names only, no path/pattern in list output.
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", JSON.stringify([collectionName]));
        return child;
      }
      if (args[0] === "collection" && args[1] === "show" && args[2] === collectionName) {
        // Real qmd `collection show` output — exposes the stale (old) path.
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          [
            `Collection: ${collectionName}`,
            `  Path:     ${oldWorkspaceDir}`,
            `  Pattern:  **/*.md`,
            `  Include:  yes (default)`,
          ].join("\n"),
        );
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    const commands = spawnMock.mock.calls.map((call: unknown[]) => call[1] as string[]);

    const removeCall = commands.find(
      (args) => args[0] === "collection" && args[1] === "remove" && args[2] === collectionName,
    );
    expect(removeCall).toBeDefined(); // rebind must remove the stale collection

    const addCall = commands.find((args) => {
      if (args[0] !== "collection" || args[1] !== "add") {
        return false;
      }
      const nameIdx = args.indexOf("--name");
      return nameIdx >= 0 && args[nameIdx + 1] === collectionName;
    });
    expect(addCall).toBeDefined();
    // The new add must target the NEW workspace path, not the old one.
    expect(addCall?.[2]).toBe(newWorkspaceDir);
  });

  it("rebinds a stale in-container collection root to the host workspace (sandbox-mode transition)", async () => {
    // Sandbox coverage: an agent that previously ran with its workspace bind-mounted under
    // /home/node/.openclaw/... stored that in-container path as the collection root. Resolved
    // with host paths, `collection show` reveals the stale container path; the rebind is
    // path-namespace-agnostic and re-binds to the current host root.
    const containerRoot = "/home/node/.openclaw/teams/x/workspace";
    const newWorkspaceDir = workspaceDir; // host path the manager is configured for

    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: newWorkspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const collectionName = `workspace-${agentId}`;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", JSON.stringify([collectionName]));
        return child;
      }
      if (args[0] === "collection" && args[1] === "show" && args[2] === collectionName) {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          [
            `Collection: ${collectionName}`,
            `  Path:     ${containerRoot}`,
            `  Pattern:  **/*.md`,
            `  Include:  yes (default)`,
          ].join("\n"),
        );
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    const commands = spawnMock.mock.calls.map((call: unknown[]) => call[1] as string[]);
    const removeCall = commands.find(
      (args) => args[0] === "collection" && args[1] === "remove" && args[2] === collectionName,
    );
    expect(removeCall).toBeDefined();
    const addCall = commands.find((args) => {
      if (args[0] !== "collection" || args[1] !== "add") {
        return false;
      }
      const nameIdx = args.indexOf("--name");
      return nameIdx >= 0 && args[nameIdx + 1] === collectionName;
    });
    expect(addCall).toBeDefined();
    // Re-added at the host workspace root, not the stale container path.
    expect(addCall?.[2]).toBe(newWorkspaceDir);
  });

  it("parseShownQmdCollection extracts path and pattern from qmd collection show output", () => {
    const sampleOutput = [
      "Collection: memory-dir-example",
      "  Path:     /home/node/.openclaw/teams/example-team/workspace-example/memory",
      "  Pattern:  **/*.md",
      "  Include:  yes (default)",
    ].join("\n");

    const result = parseShownQmdCollection(sampleOutput);
    expect(result.path).toBe("/home/node/.openclaw/teams/example-team/workspace-example/memory");
    expect(result.pattern).toBe("**/*.md");

    // Tolerant of missing fields.
    expect(parseShownQmdCollection("")).toEqual({});
    expect(parseShownQmdCollection("Collection: no-path-here\n  Include:  yes")).toEqual({});

    // Path-only (no pattern line).
    const pathOnly = parseShownQmdCollection("Collection: x\n  Path:  /some/path\n");
    expect(pathOnly.path).toBe("/some/path");
    expect(pathOnly.pattern).toBeUndefined();
  });

  it("parseListedQmdCollections accepts uppercase bare collection names", () => {
    expect(parseListedQmdCollections("Workspace-Main\n")).toEqual(
      new Map([["Workspace-Main", {}]]),
    );
  });
});

function createDeferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  if (!resolve || !reject) {
    throw new Error("Expected deferred callbacks to be initialized");
  }
  return { promise, resolve, reject };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
