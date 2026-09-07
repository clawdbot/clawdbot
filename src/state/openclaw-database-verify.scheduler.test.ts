import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const INITIAL_DELAY_MS = 5 * 60_000;
const INTERVAL_MS = 24 * 60 * 60_000;
const NOW = new Date("2026-08-11T15:00:00.000Z").getTime();
const STATE_PATH = "/test-state/state/openclaw-database-verify.json";
const TARGETS = [
  { kind: "state" as const, label: "OpenClaw state database", path: "/state.sqlite" },
  { kind: "agent" as const, label: "OpenClaw agent database main", path: "/agent.sqlite" },
];

const mocks = vi.hoisted(() => ({
  applyResults: vi.fn(),
  collectTargets: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  readJson: vi.fn(),
  runWorker: vi.fn(),
  terminateWorker: vi.fn(),
  writeJson: vi.fn(),
}));

vi.mock("../infra/json-files.js", () => ({
  tryReadJsonSync: mocks.readJson,
  writeJson: mocks.writeJson,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ error: mocks.logError, warn: mocks.logWarn }),
}));

vi.mock("./openclaw-state-db.paths.js", () => ({
  resolveOpenClawStateSqliteDir: () => "/test-state/state",
}));

vi.mock("./openclaw-database-verify.impl.js", () => ({
  OPENCLAW_DATABASE_VERIFY_INITIAL_DELAY_MS: INITIAL_DELAY_MS,
  OPENCLAW_DATABASE_VERIFY_INTERVAL_MS: INTERVAL_MS,
  applyOpenClawDatabaseVerificationResults: mocks.applyResults,
  collectOpenClawDatabaseVerifyTargets: mocks.collectTargets,
  runDatabaseVerifyWorker: mocks.runWorker,
  terminateDatabaseVerifyWorker: mocks.terminateWorker,
}));

const { startOpenClawDatabaseIntegrityVerifier } = await import("./openclaw-database-verify.js");

function successfulResults() {
  return TARGETS.map((target) => ({ path: target.path, ok: true }));
}

async function advanceToInitialRun() {
  await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
}

describe("database integrity verifier cadence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    mocks.collectTargets.mockReturnValue(TARGETS);
    mocks.readJson.mockReturnValue(undefined);
    mocks.runWorker.mockResolvedValue(successfulResults());
    mocks.terminateWorker.mockResolvedValue(undefined);
    mocks.writeJson.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("preserves the daily cadence across a restart after a recent success", async () => {
    const ageMs = 2 * 60 * 60_000;
    mocks.readJson.mockReturnValue({
      version: 1,
      lastSuccessfulVerificationAt: NOW - ageMs,
    });

    const verifier = startOpenClawDatabaseIntegrityVerifier({ env: {} });
    await vi.advanceTimersByTimeAsync(INTERVAL_MS - ageMs - 1);
    expect(mocks.runWorker).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.runWorker).toHaveBeenCalledOnce();
    await verifier.stop();
  });

  it.each([
    ["missing", undefined],
    ["malformed", { version: 1, lastSuccessfulVerificationAt: "today" }],
    ["wrong-version", { version: 2, lastSuccessfulVerificationAt: NOW - 1_000 }],
    ["expired", { version: 1, lastSuccessfulVerificationAt: NOW - INTERVAL_MS }],
    ["future", { version: 1, lastSuccessfulVerificationAt: NOW + 1 }],
  ])("uses the initial delay for %s cadence state", async (_name, state) => {
    mocks.readJson.mockReturnValue(state);
    const verifier = startOpenClawDatabaseIntegrityVerifier({ env: {} });

    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS - 1);
    expect(mocks.runWorker).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.runWorker).toHaveBeenCalledOnce();
    await verifier.stop();
  });

  it("falls back to the initial delay when cadence state cannot be read", async () => {
    mocks.readJson.mockImplementation(() => {
      throw new Error("read denied");
    });
    const verifier = startOpenClawDatabaseIntegrityVerifier({ env: {} });

    await advanceToInitialRun();
    expect(mocks.runWorker).toHaveBeenCalledOnce();
    expect(mocks.logWarn).toHaveBeenCalledWith(
      "failed to read database integrity verifier cadence",
      { error: "Error: read denied" },
    );
    await verifier.stop();
  });

  it("records a complete successful pass and keeps the daily interval", async () => {
    const verifier = startOpenClawDatabaseIntegrityVerifier({ env: {} });
    await advanceToInitialRun();

    expect(mocks.applyResults).toHaveBeenCalledWith({
      env: {},
      results: successfulResults(),
      targets: TARGETS,
    });
    expect(mocks.writeJson).toHaveBeenCalledWith(
      STATE_PATH,
      { version: 1, lastSuccessfulVerificationAt: NOW + INITIAL_DELAY_MS },
      { dirMode: 0o700, mode: 0o600, trailingNewline: true },
    );

    await vi.advanceTimersByTimeAsync(INTERVAL_MS - 1);
    expect(mocks.runWorker).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.runWorker).toHaveBeenCalledTimes(2);
    await verifier.stop();
  });

  it.each([
    [
      "inconclusive",
      [
        { path: TARGETS[0].path, ok: false, terminal: false },
        { path: TARGETS[1].path, ok: true },
      ],
    ],
    [
      "terminal failure",
      [
        { path: TARGETS[0].path, ok: false, terminal: true },
        { path: TARGETS[1].path, ok: true },
      ],
    ],
    ["incomplete", [{ path: TARGETS[0].path, ok: true }]],
    [
      "duplicate",
      [
        { path: TARGETS[0].path, ok: true },
        { path: TARGETS[0].path, ok: true },
      ],
    ],
    [
      "unknown",
      [
        { path: TARGETS[0].path, ok: true },
        { path: "/unknown.sqlite", ok: true },
      ],
    ],
  ])("does not record a %s result set", async (_name, results) => {
    mocks.runWorker.mockResolvedValue(results);
    const verifier = startOpenClawDatabaseIntegrityVerifier({ env: {} });

    await advanceToInitialRun();
    expect(mocks.applyResults).toHaveBeenCalledOnce();
    expect(mocks.writeJson).not.toHaveBeenCalled();
    await verifier.stop();
  });

  it("does not record an empty target set", async () => {
    mocks.collectTargets.mockReturnValue([]);
    const verifier = startOpenClawDatabaseIntegrityVerifier({ env: {} });

    await advanceToInitialRun();
    expect(mocks.runWorker).not.toHaveBeenCalled();
    expect(mocks.writeJson).not.toHaveBeenCalled();
    await verifier.stop();
  });

  it("does not record worker failures and retries on the daily interval", async () => {
    mocks.runWorker.mockRejectedValueOnce(new Error("worker failed"));
    const verifier = startOpenClawDatabaseIntegrityVerifier({ env: {} });

    await advanceToInitialRun();
    expect(mocks.writeJson).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledWith("database integrity verifier failed", {
      error: "Error: worker failed",
    });

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(mocks.runWorker).toHaveBeenCalledTimes(2);
    await verifier.stop();
  });

  it("keeps running when the cadence marker cannot be persisted", async () => {
    mocks.writeJson.mockRejectedValueOnce(new Error("write denied"));
    const verifier = startOpenClawDatabaseIntegrityVerifier({ env: {} });

    await advanceToInitialRun();
    expect(mocks.logWarn).toHaveBeenCalledWith(
      "failed to persist database integrity verifier cadence",
      { error: "Error: write denied" },
    );

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(mocks.runWorker).toHaveBeenCalledTimes(2);
    await verifier.stop();
  });

  it("cancels a pending timer when stopped", async () => {
    const verifier = startOpenClawDatabaseIntegrityVerifier({ env: {} });
    await verifier.stop();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    expect(mocks.runWorker).not.toHaveBeenCalled();
  });

  it("terminates an active worker when stopped", async () => {
    const worker = {} as ChildProcess;
    let finishWorker: ((results: ReturnType<typeof successfulResults>) => void) | undefined;
    mocks.runWorker.mockImplementation(
      async (_targets: unknown, options: { onWorker?: (active: ChildProcess) => void }) => {
        options.onWorker?.(worker);
        return await new Promise<ReturnType<typeof successfulResults>>((resolve) => {
          finishWorker = resolve;
        });
      },
    );
    mocks.terminateWorker.mockImplementation(async () => {
      finishWorker?.(successfulResults());
    });
    const verifier = startOpenClawDatabaseIntegrityVerifier({ env: {} });

    await advanceToInitialRun();
    await verifier.stop();

    expect(mocks.terminateWorker).toHaveBeenCalledWith(worker);
  });
});
