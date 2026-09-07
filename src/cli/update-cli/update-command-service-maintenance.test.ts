import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readScheduledTaskRuntime } from "../../daemon/schtasks-runtime.js";
import type { GatewayService } from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import * as openClawTmp from "../../infra/tmp-openclaw-dir.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../../infra/update-control-plane-sentinel.js";
import { getFileLockProcessStartTime } from "../../shared/pid-alive.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";

const mocks = vi.hoisted(() => ({
  service: vi.fn<() => GatewayService>(),
  taskState: 3 as number | string,
}));

vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: mocks.service,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(() => ({
    pid: 0,
    output: [null, JSON.stringify({ state: mocks.taskState, lastRunResult: 0 }), ""],
    stdout: JSON.stringify({ state: mocks.taskState, lastRunResult: 0 }),
    stderr: "",
    status: 0,
    signal: null,
  })),
}));

beforeEach(() => mockSystemAccountHome());
afterEach(() => vi.restoreAllMocks());

async function withServiceHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await makeTempWorkspace("openclaw-update-service-");
  try {
    await withEnvAsync(
      {
        HOME: home,
        USERPROFILE: home,
        APPDATA: path.join(home, "AppData"),
        OPENCLAW_GATEWAY_PORT: undefined,
        OPENCLAW_HOME: undefined,
        OPENCLAW_STATE_DIR: undefined,
        OPENCLAW_CONFIG_PATH: undefined,
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_SUPERVISOR_MODE: undefined,
        OPENCLAW_SERVICE_MARKER: undefined,
        OPENCLAW_SERVICE_KIND: undefined,
      },
      () => run(home),
    );
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

type NativeOfflineCase = {
  platform: NodeJS.Platform;
  label: string;
  runtime: "running" | "stopped" | "unknown";
  loaded: boolean;
  offline: boolean;
  enabled?: boolean;
  state?: number | string;
};

const nativeOfflineCases: NativeOfflineCase[] = [
  {
    platform: "linux",
    label: "terminal inactive",
    runtime: "stopped",
    loaded: true,
    offline: true,
  },
  {
    platform: "linux",
    label: "restart transition",
    runtime: "unknown",
    loaded: true,
    offline: false,
  },
  { platform: "linux", label: "running", runtime: "running", loaded: true, offline: false },
  { platform: "darwin", label: "unloaded", runtime: "stopped", loaded: false, offline: true },
  {
    platform: "darwin",
    label: "loaded enabled",
    runtime: "stopped",
    loaded: true,
    enabled: true,
    offline: false,
  },
  {
    platform: "darwin",
    label: "loaded disabled",
    runtime: "stopped",
    loaded: true,
    enabled: false,
    offline: true,
  },
  {
    platform: "darwin",
    label: "enabled unknown",
    runtime: "stopped",
    loaded: true,
    offline: false,
  },
  ...[
    { label: "disabled", state: 1, offline: true },
    { label: "ready", state: 3, offline: true },
    { label: "queued", state: 2, offline: false },
    { label: "running", state: 4, offline: false },
    { label: "unknown", state: 0, offline: false },
    { label: "malformed", state: "3 trailing output", offline: false },
  ].map<NativeOfflineCase>((task) => ({
    platform: "win32",
    runtime:
      task.state === 1 || task.state === 3 ? "stopped" : task.state === 4 ? "running" : "unknown",
    loaded: true,
    label: task.label,
    state: task.state,
    offline: task.offline,
  })),
];

it.each(nativeOfflineCases)(
  "requires affirmative native offline proof for owned $platform service ($label)",
  (scenario) =>
    withServiceHome(async (home) => {
      mockProcessPlatform(scenario.platform);
      mocks.taskState = scenario.state ?? 3;
      const service = createMockGatewayService({
        readCommand: async () => ({
          programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
          environment: { HOME: home },
        }),
        readRuntime:
          scenario.platform === "win32"
            ? readScheduledTaskRuntime
            : async () => ({ status: scenario.runtime }),
        isLoaded: async () => scenario.loaded,
        isEnabled: async () => {
          if (scenario.enabled === undefined) {
            throw new Error("enabled state unavailable");
          }
          return scenario.enabled;
        },
      });
      mocks.service.mockReturnValue(service);
      const inspected = await maybeStopManagedServiceBeforeMutableUpdate({
        root: process.cwd(),
        updateInstallKind: "package",
        shouldRestart: true,
        phase: "inspect",
        jsonMode: true,
      });
      expect(inspected.serviceUpdateVerdict?.kind).toBe(
        scenario.runtime === "unknown" ? "unavailable" : "owned",
      );
      expect(inspected.offline).toBe(scenario.offline);
      expect(service.stop).not.toHaveBeenCalled();
      expect(service.start).not.toHaveBeenCalled();
      expect(service.restart).not.toHaveBeenCalled();
      expect(service.stage).not.toHaveBeenCalled();
      expect(service.install).not.toHaveBeenCalled();
    }),
);

it
  .runIf(process.platform === "linux" || process.platform === "darwin")
  .each([
    "current updater",
    "missing marker",
    "missing metadata",
    "missing lease",
    "replaced owner",
    "different root",
    "different run",
    "stale start identity",
    "parent lease",
    "native preparation",
  ])("keeps serving-ancestor inspection bound to the current updater: %s", (scenario) =>
  withServiceHome(async (home) => {
    const root = await fs.realpath(process.cwd());
    const metaPath = path.join(home, "handoff-meta.json");
    vi.spyOn(openClawTmp, "resolvePreferredOpenClawTmpDir").mockReturnValue(home);
    await fs.writeFile(
      metaPath,
      JSON.stringify({
        version: 1,
        meta: {
          root: scenario === "different root" ? home : root,
          runId: scenario === "different run" ? "other-run" : "update-run",
          handoffId: "owned-handoff",
        },
      }),
    );
    const leasePid = scenario === "parent lease" ? process.ppid : process.pid;
    const startIdentity = getFileLockProcessStartTime(leasePid);
    expect(startIdentity).not.toBeNull();
    const db = openNodeSqliteDatabase(path.join(home, "managed-update-handoffs.sqlite"));
    try {
      db.exec(`CREATE TABLE managed_update_handoffs (
        install_root TEXT PRIMARY KEY, owner TEXT NOT NULL, payload_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      ) STRICT;`);
      if (scenario !== "missing lease") {
        db.prepare("INSERT INTO managed_update_handoffs VALUES (?, ?, ?, ?)").run(
          root,
          scenario === "replaced owner" ? "replacement-handoff" : "owned-handoff",
          JSON.stringify({
            version: 1,
            pid: leasePid,
            startIdentity: scenario === "stale start identity" ? "stale" : String(startIdentity),
          }),
          Date.now(),
        );
      }
    } finally {
      db.close();
    }
    await withEnvAsync(
      {
        OPENCLAW_UPDATE_RUN_HANDOFF: scenario === "missing marker" ? undefined : "1",
        [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]:
          scenario === "missing metadata" ? undefined : metaPath,
      },
      async () => {
        const service = createMockGatewayService({
          readCommand: async () => ({
            programArguments: [process.execPath, path.join(root, "openclaw.mjs"), "gateway"],
            environment: { HOME: home },
          }),
          readRuntime: async () => ({ status: "running", pid: process.ppid }),
          isLoaded: async () => true,
        });
        mocks.service.mockReturnValue(service);
        const inspected = await maybeStopManagedServiceBeforeMutableUpdate({
          root,
          updateInstallKind: "package",
          shouldRestart: true,
          jsonMode: true,
          phase: scenario === "native preparation" ? "prepare" : "inspect",
          updateRun: { runId: "update-run", env: process.env },
          handoffFromGateway: async () => false,
        });
        expect(inspected.serviceUpdateVerdict?.kind).toBe("owned");
        if (scenario === "current updater") {
          expect(inspected.blockMessage).toBeUndefined();
        } else {
          expect(inspected.blockMessage).toContain("inside the gateway process tree");
        }
        for (const mutate of [
          service.stop,
          service.start,
          service.restart,
          service.stage,
          service.install,
        ]) {
          expect(mutate).not.toHaveBeenCalled();
        }
      },
    );
  }),
);
