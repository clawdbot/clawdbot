import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  leaseActive: false,
  readConfig: vi.fn(),
}));

const validConfigSnapshot = {
  valid: true,
  parsed: {},
  config: {},
  runtimeConfig: {},
  sourceConfig: {},
  warnings: [],
  issues: [],
  legacyIssues: [],
};

const successfulPluginUpdate = {
  status: "ok",
  changed: true,
  sync: {
    changed: false,
    switchedToBundled: [],
    switchedToNpm: [],
    warnings: [],
    errors: [],
  },
  npm: { changed: false, outcomes: [] },
  integrityDrifts: [],
  warnings: [],
};

function record(name: string): void {
  mocks.events.push(`${name}:${mocks.leaseActive}`);
}

vi.mock("../../commands/doctor.js", () => ({
  doctorCommand: vi.fn(async () => {
    record("doctor");
  }),
}));

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  assertConfigWriteAllowedInCurrentMode: vi.fn(),
  readConfigFileSnapshot: mocks.readConfig,
}));

vi.mock("../../plugins/installed-plugin-index-records.js", () => ({
  loadInstalledPluginIndexInstallRecords: vi.fn(async () => {
    record("installed-records");
    return {};
  }),
}));

vi.mock("../../plugins/installed-plugin-index-store.js", () => ({
  readPersistedInstalledPluginIndex: vi.fn(async () => {
    record("persisted-index");
    return null;
  }),
}));

vi.mock("../../plugins/plugin-lifecycle-lease.js", () => ({
  withPluginLifecycleLease: async (_params: unknown, run: () => Promise<unknown>) => {
    mocks.events.push("lease-enter:false");
    mocks.leaseActive = true;
    try {
      return await run();
    } finally {
      mocks.leaseActive = false;
      mocks.events.push("lease-exit:false");
    }
  },
}));

vi.mock("../../state/openclaw-state-db.paths.js", () => ({
  resolveOpenClawStateSqlitePath: vi.fn(() => "/tmp/openclaw.sqlite"),
}));

vi.mock("../../state/openclaw-state-ownership.js", () => ({
  assertOpenClawStateWriteAllowedAtPath: vi.fn(async () => undefined),
}));

vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  parseTimeoutMsOrExit: vi.fn(() => 1_000),
  readPackageVersion: vi.fn(async () => "2026.8.27"),
  resolveUpdateRoot: vi.fn(async () => "/tmp/openclaw"),
  tryWriteCompletionCache: vi.fn(async () => "completed"),
}));

vi.mock("./update-command-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-config.js")>()),
  createUpdateConfigSnapshot: vi.fn(async () => {
    record("config-snapshot");
  }),
  persistRequestedUpdateChannel: vi.fn(async (params: { configSnapshot: unknown }) => {
    record("persist-channel");
    return params.configSnapshot;
  }),
  readPostCorePreUpdateSourceConfig: vi.fn(async () => ({
    sourceConfig: {},
    authoredConfig: {},
  })),
  restoreDroppedPreUpdateChannels: vi.fn((snapshot: unknown) => {
    record("restore-channels");
    return {
      snapshot,
      changed: false,
      authoredChannels: [],
    };
  }),
}));

vi.mock("./update-command-fresh-doctor.js", () => ({
  completePostCorePluginUpdate: vi.fn(async () => {
    record("complete");
    return {
      pluginUpdate: successfulPluginUpdate,
      configSnapshot: validConfigSnapshot,
    };
  }),
  runUpdateFinalizationDoctorInFreshProcess: vi.fn(async () => {
    record("fresh-doctor");
  }),
  withPrePluginUpdateDoctorEnv: async (run: () => Promise<unknown>) => await run(),
}));

vi.mock("./update-command-plugins.js", () => ({
  updatePluginsAfterCoreUpdate: vi.fn(async () => {
    record("plugin-update");
    return successfulPluginUpdate;
  }),
}));

vi.mock("./update-command-post-core.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-post-core.js")>()),
  readPostCorePluginInstallRecordsFile: vi.fn(async () => {
    record("handoff-records");
    return {};
  }),
  resolvePostCoreUpdateStartedAtMs: vi.fn(async () => 1_000),
  writePostCorePluginUpdateResultFile: vi.fn(async () => undefined),
}));

import { updateFinalizeCommand } from "./update-command-finalize.js";
import { resumePostCoreUpdate } from "./update-command-resume.js";

function expectLifecycleBoundary(doctorEvent: string): void {
  const doctorIndex = mocks.events.indexOf(`${doctorEvent}:false`);
  expect(doctorIndex).toBeGreaterThan(-1);
  expect(mocks.events).not.toContain(`${doctorEvent}:true`);
  const authoritativeReadIndex = mocks.events.findIndex(
    (event, index) => index > doctorIndex && event === "read-config:true",
  );
  expect(authoritativeReadIndex).toBeGreaterThan(doctorIndex);
  for (const event of [
    "persist-channel:true",
    "restore-channels:true",
    "installed-records:true",
    "plugin-update:true",
  ]) {
    expect(mocks.events).toContain(event);
  }
  expect(mocks.events.indexOf("plugin-update:true")).toBeGreaterThan(authoritativeReadIndex);
  const lastLeaseExit = mocks.events.lastIndexOf("lease-exit:false");
  expect(mocks.events.indexOf("complete:false")).toBeGreaterThan(lastLeaseExit);
}

describe("update plugin lifecycle lease boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mocks.events = [];
    mocks.leaseActive = false;
    mocks.readConfig.mockImplementation(async () => {
      record("read-config");
      return validConfigSnapshot;
    });
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
  });

  it("runs resume doctors outside the lease and rereads mutation state after acquisition", async () => {
    await resumePostCoreUpdate({
      root: "/tmp/openclaw",
      channel: "stable",
      opts: { yes: true },
      timeoutMs: 1_000,
    });

    expectLifecycleBoundary("fresh-doctor");
    expect(mocks.events).toContain("persisted-index:true");
    expect(mocks.events).toContain("handoff-records:false");
  });

  it("runs finalizer doctors outside the lease and rereads mutation state after acquisition", async () => {
    await updateFinalizeCommand({
      channel: "stable",
      deferCompletionCache: true,
      json: true,
      yes: true,
    });

    expectLifecycleBoundary("doctor");
    const doctorIndex = mocks.events.indexOf("doctor:false");
    expect(mocks.events.slice(0, doctorIndex)).toContain("read-config:true");
    expect(mocks.events).not.toContain("persisted-index:true");
  });
});
