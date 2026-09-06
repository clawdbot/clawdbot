import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readScheduledTaskRuntime } from "../../daemon/schtasks-runtime.js";
import type { GatewayService } from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
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
  async (scenario) => {
    const home = await makeTempWorkspace("openclaw-update-offline-");
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
        async () => {
          mockProcessPlatform(scenario.platform);
          mocks.taskState = scenario.state ?? 3;
          const service = createMockGatewayService({
            readCommand: async () => ({
              programArguments: [
                process.execPath,
                path.join(process.cwd(), "openclaw.mjs"),
                "gateway",
              ],
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
        },
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  },
);
