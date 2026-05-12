import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../../version.js";
import {
  defaultRuntime,
  resetLifecycleRuntimeLogs,
  resetLifecycleServiceMocks,
  service,
  stubEmptyGatewayEnv,
} from "./test-helpers/lifecycle-core-harness.js";

const readConfigFileSnapshotMock = vi.fn();
const loadConfig = vi.fn(() => ({}));
const newerConfigHints = [
  "Run the newer openclaw binary on PATH, or reinstall the intended gateway service from the newer install.",
  "Set OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS=1 only for an intentional downgrade or recovery action.",
];
const newerConfigHintItems = newerConfigHints.map((text) => ({ kind: "generic", text }));

function expectLatestRuntimeJson(payload: unknown) {
  expect(defaultRuntime.writeJson.mock.calls.at(-1)?.[0]).toEqual(payload);
}

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => loadConfig(),
  loadConfig: () => loadConfig(),
  readConfigFileSnapshot: () => readConfigFileSnapshotMock(),
}));

vi.mock("../../config/issue-format.js", () => ({
  formatConfigIssueLines: (
    issues: Array<{ path: string; message: string }>,
    _prefix: string,
    _opts?: unknown,
  ) => issues.map((i) => `${i.path}: ${i.message}`),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime,
}));

function setConfigSnapshot(params: {
  exists: boolean;
  valid: boolean;
  issues?: Array<{ path: string; message: string }>;
  lastTouchedVersion?: string;
}) {
  const config = params.lastTouchedVersion
    ? { meta: { lastTouchedVersion: params.lastTouchedVersion } }
    : {};
  readConfigFileSnapshotMock.mockResolvedValue({
    exists: params.exists,
    valid: params.valid,
    config,
    sourceConfig: config,
    issues: params.issues ?? [],
  });
}

function createServiceRunArgs() {
  return {
    serviceNoun: "Gateway",
    service,
    renderStartHints: () => [],
    opts: { json: true },
  };
}

describe("runServiceRestart config pre-flight (#35862)", () => {
  let runServiceRestart: typeof import("./lifecycle-core.js").runServiceRestart;

  beforeAll(async () => {
    ({ runServiceRestart } = await import("./lifecycle-core.js"));
  });

  beforeEach(() => {
    resetLifecycleRuntimeLogs();
    readConfigFileSnapshotMock.mockReset();
    setConfigSnapshot({ exists: true, valid: true });
    loadConfig.mockReset();
    loadConfig.mockReturnValue({});
    resetLifecycleServiceMocks();
    stubEmptyGatewayEnv();
  });

  it("aborts restart when config is invalid", async () => {
    setConfigSnapshot({
      exists: true,
      valid: false,
      issues: [{ path: "agents.defaults.pdfModel", message: "Unrecognized key" }],
    });

    await expect(runServiceRestart(createServiceRunArgs())).rejects.toThrow("__exit__:1");

    expect(service.restart).not.toHaveBeenCalled();
  });

  it("blocks restart from an older binary when config was written by a newer one", async () => {
    setConfigSnapshot({ exists: true, valid: true, lastTouchedVersion: "9999.1.1" });

    await expect(runServiceRestart(createServiceRunArgs())).rejects.toThrow("__exit__:1");

    expect(service.restart).not.toHaveBeenCalled();
    expectLatestRuntimeJson({
      action: "restart",
      ok: false,
      error: `Gateway restart blocked: Refusing to restart the gateway service because this OpenClaw binary (${VERSION}) is older than the config last written by OpenClaw 9999.1.1.`,
      hints: newerConfigHints,
      hintItems: newerConfigHintItems,
      warnings: undefined,
    });
  });

  it("proceeds with restart when config is valid", async () => {
    setConfigSnapshot({ exists: true, valid: true });

    const result = await runServiceRestart(createServiceRunArgs());

    expect(result).toBe(true);
    expect(service.restart).toHaveBeenCalledTimes(1);
  });

  it("proceeds with restart when config file does not exist", async () => {
    setConfigSnapshot({ exists: false, valid: true });

    const result = await runServiceRestart(createServiceRunArgs());

    expect(result).toBe(true);
    expect(service.restart).toHaveBeenCalledTimes(1);
  });

  it("proceeds with restart when snapshot read throws", async () => {
    readConfigFileSnapshotMock.mockRejectedValue(new Error("read failed"));

    const result = await runServiceRestart(createServiceRunArgs());

    expect(result).toBe(true);
    expect(service.restart).toHaveBeenCalledTimes(1);
  });
});

describe("runServiceStart config pre-flight (#35862)", () => {
  let runServiceStart: typeof import("./lifecycle-core.js").runServiceStart;

  beforeAll(async () => {
    ({ runServiceStart } = await import("./lifecycle-core.js"));
  });

  beforeEach(() => {
    resetLifecycleRuntimeLogs();
    readConfigFileSnapshotMock.mockReset();
    setConfigSnapshot({ exists: true, valid: true });
    resetLifecycleServiceMocks();
  });

  it("aborts start when config is invalid", async () => {
    setConfigSnapshot({
      exists: true,
      valid: false,
      issues: [{ path: "agents.defaults.pdfModel", message: "Unrecognized key" }],
    });

    await expect(runServiceStart(createServiceRunArgs())).rejects.toThrow("__exit__:1");

    expect(service.restart).not.toHaveBeenCalled();
  });

  it("aborts before not-loaded start recovery when config is invalid", async () => {
    const onNotLoaded = vi.fn(async () => ({
      result: "started" as const,
      loaded: true,
    }));
    setConfigSnapshot({
      exists: true,
      valid: false,
      issues: [{ path: "agents.defaults.pdfModel", message: "Unrecognized key" }],
    });

    await expect(
      runServiceStart({
        ...createServiceRunArgs(),
        onNotLoaded,
      }),
    ).rejects.toThrow("__exit__:1");

    expect(onNotLoaded).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
  });

  it("proceeds with start when config is valid", async () => {
    setConfigSnapshot({ exists: true, valid: true });

    await runServiceStart(createServiceRunArgs());

    expect(service.restart).toHaveBeenCalledTimes(1);
  });
});

describe("runServiceStop future-config guard", () => {
  let runServiceStop: typeof import("./lifecycle-core.js").runServiceStop;

  beforeAll(async () => {
    ({ runServiceStop } = await import("./lifecycle-core.js"));
  });

  beforeEach(() => {
    resetLifecycleRuntimeLogs();
    readConfigFileSnapshotMock.mockReset();
    setConfigSnapshot({ exists: true, valid: true });
    resetLifecycleServiceMocks();
  });

  it("blocks stop from an older binary when config was written by a newer one", async () => {
    setConfigSnapshot({ exists: true, valid: true, lastTouchedVersion: "9999.1.1" });

    await expect(
      runServiceStop({
        serviceNoun: "Gateway",
        service,
        opts: { json: true },
      }),
    ).rejects.toThrow("__exit__:1");

    expect(service.stop).not.toHaveBeenCalled();
    expectLatestRuntimeJson({
      action: "stop",
      ok: false,
      error: `Gateway stop blocked: Refusing to stop the gateway service because this OpenClaw binary (${VERSION}) is older than the config last written by OpenClaw 9999.1.1.`,
      hints: newerConfigHints,
      hintItems: newerConfigHintItems,
      warnings: undefined,
    });
  });
});
