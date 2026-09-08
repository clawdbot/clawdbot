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

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  assertConfigWriteAllowedInCurrentMode: vi.fn(),
  readConfigFileSnapshot: mocks.readConfig,
}));

// This fixture proves lease ordering; process tests cover durable ledger writes.
vi.mock("../../infra/update-run-ledger.js", () => ({
  createUpdateRun: vi.fn(() => ({ runId: "lease-order-fixture" })),
  adoptUpdateRun: vi.fn(() => ({
    origin: { driver: { host: "lease-order-fixture", pid: 1, startIdentity: "1" } },
  })),
  heartbeatUpdateRun: vi.fn(),
  recordUpdateRunStep: vi.fn(),
  finishUpdateRun: vi.fn(),
  recordUpdateRunDiagnostic: vi.fn(),
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

vi.mock("./update-command-config-snapshot.js", () => ({
  createUpdateConfigSnapshot: vi.fn(async () => {
    record("config-snapshot");
  }),
}));

vi.mock("./update-command-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-config.js")>()),
  persistRequestedUpdateChannel: vi.fn(async (params: { configSnapshot: unknown }) => {
    record("persist-channel");
    return params.configSnapshot;
  }),
  readPostCorePreUpdateSourceConfig: vi.fn(async () => ({
    sourceConfig: {},
    authoredConfig: {},
  })),
  preparePostCorePluginConfig: vi.fn(async () => {
    const configSnapshot = await mocks.readConfig();
    record("prepare-config");
    return {
      configSnapshot,
      configWriteOptions: {},
      configChanged: false,
      restoredAuthoredChannels: [],
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
import { withOwnedManagedUpdateEnv } from "./update-command-managed-context.js";
import { resumePostCoreUpdate } from "./update-command-resume.js";

function expectLifecycleBoundary(preLeaseEvent: string): void {
  const preLeaseIndex = mocks.events.indexOf(`${preLeaseEvent}:false`);
  expect(preLeaseIndex).toBeGreaterThan(-1);
  expect(mocks.events).not.toContain(`${preLeaseEvent}:true`);
  const authoritativeReadIndex = mocks.events.findIndex(
    (event, index) => index > preLeaseIndex && event === "read-config:true",
  );
  expect(authoritativeReadIndex).toBeGreaterThan(preLeaseIndex);
  for (const event of ["prepare-config:true", "installed-records:true", "plugin-update:true"]) {
    expect(mocks.events).toContain(event);
  }
  expect(mocks.events.indexOf("plugin-update:true")).toBeGreaterThan(authoritativeReadIndex);
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

  it.each(["copied", "live"] as const)(
    "preserves the %s invocation environment through a failed phase",
    async (source) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", "/fixture/invocation-state");
      const failure = new Error("phase failed");
      let observedStateDir: string | undefined;
      try {
        await expect(
          withOwnedManagedUpdateEnv(
            source === "live" ? process.env : { ...process.env },
            async () => {
              observedStateDir = process.env.OPENCLAW_STATE_DIR;
              process.env.OPENCLAW_STATE_DIR = "/fixture/phase-state";
              throw failure;
            },
          ),
        ).rejects.toBe(failure);
        expect(observedStateDir).toBe("/fixture/invocation-state");
        expect(process.env.OPENCLAW_STATE_DIR).toBe("/fixture/invocation-state");
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("returns resumed package work without Doctor completion and rereads state under the lease", async () => {
    await resumePostCoreUpdate({
      root: "/tmp/openclaw",
      channel: "stable",
      opts: { yes: true },
      timeoutMs: 1_000,
    });

    expectLifecycleBoundary("handoff-records");
    expect(mocks.events).not.toContain("fresh-doctor:false");
    expect(mocks.events).not.toContain("fresh-doctor:true");
    expect(mocks.events).not.toContain("config-snapshot:false");
    expect(mocks.events).not.toContain("config-snapshot:true");
    expect(mocks.events).not.toContain("complete:false");
    expect(mocks.events).not.toContain("complete:true");
    expect(mocks.events).toContain("persisted-index:true");
  });

  it("runs finalizer doctors outside the lease and rereads mutation state after acquisition", async () => {
    await updateFinalizeCommand({
      channel: "stable",
      deferCompletionCache: true,
      json: true,
      yes: true,
    });

    expectLifecycleBoundary("fresh-doctor");
    const doctorIndex = mocks.events.indexOf("fresh-doctor:false");
    expect(mocks.events.slice(0, doctorIndex)).toContain("read-config:true");
    expect(mocks.events.indexOf("complete:false")).toBeGreaterThan(
      mocks.events.lastIndexOf("lease-exit:false"),
    );
    expect(mocks.events).not.toContain("persisted-index:true");
  });
});
