import type { AcpRuntime, AcpRuntimeCapabilities } from "@openclaw/acp-core/runtime/types";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { resetAcpManagerTaskStateForTests } from "../../../test/helpers/acp-manager-task-state.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { AcpSessionRuntimeOptions, SessionAcpMeta } from "../../config/sessions/types.js";
import { resetHeartbeatWakeStateForTests } from "../../infra/heartbeat-wake.js";
import { resetAcpActiveTurnsForTests } from "./active-turns.js";

export type { AcpRuntime, OpenClawConfig, SessionAcpMeta };

const hoistedMocks = vi.hoisted(() => {
  const listAcpSessionEntriesMock = vi.fn();
  const readAcpSessionEntryMock = vi.fn();
  const upsertAcpSessionMetaMock = vi.fn();
  const getAcpRuntimeBackendMock = vi.fn();
  const requireAcpRuntimeBackendMock = vi.fn();
  return {
    listAcpSessionEntriesMock,
    readAcpSessionEntryMock,
    upsertAcpSessionMetaMock,
    getAcpRuntimeBackendMock,
    requireAcpRuntimeBackendMock,
  };
});

vi.mock("../runtime/session-meta.js", () => ({
  listAcpSessionEntries: (params: unknown) => hoistedMocks.listAcpSessionEntriesMock(params),
  readAcpSessionEntry: (params: unknown) => hoistedMocks.readAcpSessionEntryMock(params),
  upsertAcpSessionMeta: (params: unknown) => hoistedMocks.upsertAcpSessionMetaMock(params),
}));

vi.mock("../runtime/registry.js", () => ({
  getAcpRuntimeBackend: (backendId?: string) => hoistedMocks.getAcpRuntimeBackendMock(backendId),
  requireAcpRuntimeBackend: (backendId?: string) =>
    hoistedMocks.requireAcpRuntimeBackendMock(backendId),
}));

export const hoisted = hoistedMocks;

const managerModule = await import("./manager.js");
export const AcpSessionManager = managerModule.AcpSessionManager;
export const resetAcpSessionManagerForTests = () =>
  managerModule.testing.resetAcpSessionManagerForTests();
export const { AcpRuntimeError } = await import("../runtime/errors.js");

export const baseCfg = {
  acp: {
    enabled: true,
    backend: "acpx",
    dispatch: { enabled: true },
  },
} as const;
export const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

export async function flushMicrotasks(rounds = 3): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

export function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  if (!resolve) {
    throw new Error("Expected deferred resolver to be initialized");
  }
  return { promise, resolve };
}

export function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

export async function expectRejectedRecord(
  promise: Promise<unknown>,
  expected: Record<string, unknown>,
) {
  await promise.then(
    () => {
      throw new Error("Expected promise to reject.");
    },
    (error: unknown) => {
      expectRecordFields(error, expected);
    },
  );
}

export function mockCallArg(
  mock: ReturnType<typeof vi.fn>,
  callIndex = 0,
): Record<string, unknown> {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[0] as Record<string, unknown>;
}

export function mockCallArgs(mock: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return mock.mock.calls.map((call) => call[0] as Record<string, unknown>);
}

export function findMockCallFields(
  mock: ReturnType<typeof vi.fn>,
  expected: Record<string, unknown>,
) {
  return mockCallArgs(mock).find((actual) =>
    Object.entries(expected).every(([key, value]) => Object.is(actual[key], value)),
  );
}

export function expectMockCallFields(
  mock: ReturnType<typeof vi.fn>,
  expected: Record<string, unknown>,
) {
  if (!findMockCallFields(mock, expected)) {
    throw new Error(`Expected mock call ${JSON.stringify(expected)}`);
  }
}

export function expectNoMockCallFields(
  mock: ReturnType<typeof vi.fn>,
  expected: Record<string, unknown>,
) {
  expect(findMockCallFields(mock, expected)).toBeUndefined();
}

export function createRuntime(): {
  runtime: AcpRuntime;
  ensureSession: ReturnType<typeof vi.fn<AcpRuntime["ensureSession"]>>;
  runTurn: ReturnType<typeof vi.fn<AcpRuntime["runTurn"]>>;
  prepareFreshSession: ReturnType<typeof vi.fn<NonNullable<AcpRuntime["prepareFreshSession"]>>>;
  cancel: ReturnType<typeof vi.fn<AcpRuntime["cancel"]>>;
  close: ReturnType<typeof vi.fn<AcpRuntime["close"]>>;
  getCapabilities: ReturnType<typeof vi.fn<NonNullable<AcpRuntime["getCapabilities"]>>>;
  getStatus: ReturnType<typeof vi.fn<NonNullable<AcpRuntime["getStatus"]>>>;
  setMode: ReturnType<typeof vi.fn<NonNullable<AcpRuntime["setMode"]>>>;
  setConfigOption: ReturnType<typeof vi.fn<NonNullable<AcpRuntime["setConfigOption"]>>>;
} {
  const ensureSession = vi.fn<AcpRuntime["ensureSession"]>(
    async (input: {
      sessionKey: string;
      agent: string;
      mode: "persistent" | "oneshot";
      model?: string;
      thinking?: string;
      cwd?: string;
      resumeSessionId?: string;
    }) => ({
      sessionKey: input.sessionKey,
      backend: "acpx",
      runtimeSessionName: `${input.sessionKey}:${input.mode}:runtime`,
    }),
  );
  const runTurn = vi.fn<AcpRuntime["runTurn"]>(async function* () {
    yield { type: "done" as const };
  });
  const prepareFreshSession = vi.fn<NonNullable<AcpRuntime["prepareFreshSession"]>>(async () => {});
  const cancel = vi.fn<AcpRuntime["cancel"]>(async () => {});
  const close = vi.fn<AcpRuntime["close"]>(async () => {});
  const getCapabilities = vi.fn<NonNullable<AcpRuntime["getCapabilities"]>>(
    async (): Promise<AcpRuntimeCapabilities> => ({
      controls: ["session/set_mode", "session/set_config_option", "session/status"],
    }),
  );
  const getStatus = vi.fn<NonNullable<AcpRuntime["getStatus"]>>(async () => ({
    summary: "status=alive",
    details: { status: "alive" },
  }));
  const setMode = vi.fn<NonNullable<AcpRuntime["setMode"]>>(async () => {});
  const setConfigOption = vi.fn<NonNullable<AcpRuntime["setConfigOption"]>>(async () => {});
  return {
    runtime: {
      ensureSession,
      runTurn,
      getCapabilities,
      getStatus,
      setMode,
      setConfigOption,
      prepareFreshSession,
      cancel,
      close,
    },
    ensureSession,
    runTurn,
    prepareFreshSession,
    cancel,
    close,
    getCapabilities,
    getStatus,
    setMode,
    setConfigOption,
  };
}

export function readySessionMeta(overrides: Partial<SessionAcpMeta> = {}): SessionAcpMeta {
  return {
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: "runtime-1",
    mode: "persistent" as const,
    state: "idle" as const,
    lastActivityAt: Date.now(),
    ...overrides,
  };
}

export function extractStatesFromUpserts(): SessionAcpMeta["state"][] {
  const states: SessionAcpMeta["state"][] = [];
  for (const [firstArg] of hoisted.upsertAcpSessionMetaMock.mock.calls) {
    const payload = firstArg as {
      mutate: (
        current: SessionAcpMeta | undefined,
        entry: { acp?: SessionAcpMeta } | undefined,
      ) => SessionAcpMeta | null | undefined;
    };
    const current = readySessionMeta();
    const next = payload.mutate(current, { acp: current });
    if (next?.state) {
      states.push(next.state);
    }
  }
  return states;
}

export function extractStateUpsertPersistenceOptions(): Array<{
  state: SessionAcpMeta["state"];
  skipMaintenance?: boolean;
  takeCacheOwnership?: boolean;
}> {
  const options: Array<{
    state: SessionAcpMeta["state"];
    skipMaintenance?: boolean;
    takeCacheOwnership?: boolean;
  }> = [];
  for (const [firstArg] of hoisted.upsertAcpSessionMetaMock.mock.calls) {
    const payload = firstArg as {
      skipMaintenance?: boolean;
      takeCacheOwnership?: boolean;
      mutate: (
        current: SessionAcpMeta | undefined,
        entry: { acp?: SessionAcpMeta } | undefined,
      ) => SessionAcpMeta | null | undefined;
    };
    const current = readySessionMeta();
    const next = payload.mutate(current, { acp: current });
    if (next?.state && payload.skipMaintenance && payload.takeCacheOwnership) {
      options.push({
        state: next.state,
        skipMaintenance: true,
        takeCacheOwnership: true,
      });
    }
  }
  return options;
}

export function extractRuntimeOptionsFromUpserts(): Array<AcpSessionRuntimeOptions | undefined> {
  const options: Array<AcpSessionRuntimeOptions | undefined> = [];
  for (const [firstArg] of hoisted.upsertAcpSessionMetaMock.mock.calls) {
    const payload = firstArg as {
      mutate: (
        current: SessionAcpMeta | undefined,
        entry: { acp?: SessionAcpMeta } | undefined,
      ) => SessionAcpMeta | null | undefined;
    };
    const current = readySessionMeta();
    const next = payload.mutate(current, { acp: current });
    if (next) {
      options.push(next.runtimeOptions);
    }
  }
  return options;
}

export function installAcpSessionManagerTestLifecycle(): void {
  beforeEach(() => {
    resetAcpSessionManagerForTests();
    resetAcpActiveTurnsForTests();
    vi.useRealTimers();
    hoisted.listAcpSessionEntriesMock.mockReset().mockResolvedValue([]);
    hoisted.readAcpSessionEntryMock.mockReset();
    hoisted.upsertAcpSessionMetaMock.mockReset().mockResolvedValue(null);
    hoisted.requireAcpRuntimeBackendMock.mockReset();
    hoisted.getAcpRuntimeBackendMock.mockReset().mockImplementation((backendId?: string) => {
      try {
        return hoisted.requireAcpRuntimeBackendMock(backendId);
      } catch {
        return null;
      }
    });
  });

  afterEach(() => {
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetHeartbeatWakeStateForTests();
    resetAcpManagerTaskStateForTests();
  });
}
