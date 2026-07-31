import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferred } from "../test-utils/deferred.js";

const { getRuntimeConfigMock, stopAllMock } = vi.hoisted(() => ({
  getRuntimeConfigMock: vi.fn(),
  stopAllMock: vi.fn<() => Promise<void>>(),
}));

vi.mock("../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.js")>()),
  getRuntimeConfig: getRuntimeConfigMock,
}));

vi.mock("./cron-stream-watchers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cron-stream-watchers.js")>()),
  createCronStreamWatchers: () => ({
    reconcile: vi.fn(async () => {}),
    resume: vi.fn(),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    stopAll: stopAllMock,
    activeJobIds: () => [],
    inspect: () => undefined,
  }),
}));

import { buildGatewayCronService } from "./server-cron.js";
import { sessionHasAutomation } from "./session-automation-index.js";

type StartedGatewayCron = {
  state: ReturnType<typeof buildGatewayCronService>;
  cfg: OpenClawConfig;
  stateDir: string;
};

async function startGatewayCron(label: string): Promise<StartedGatewayCron> {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), `openclaw-cron-drain-${label}-`));
  const cfg: OpenClawConfig = {
    session: { mainKey: "main" },
    cron: { triggers: { enabled: true } },
  };
  getRuntimeConfigMock.mockReturnValue(cfg);
  const state = buildGatewayCronService({
    cfg,
    deps: {} as CliDeps,
    broadcast: () => {},
    env: { ...process.env, OPENCLAW_SKIP_CRON: "0", OPENCLAW_STATE_DIR: stateDir },
  });
  await state.cron.start();
  await state.cron.add({
    name: `${label} stream source`,
    enabled: true,
    schedule: { kind: "stream", command: ["source"] },
    payload: { kind: "systemEvent", text: "event" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
  });
  return { state, cfg, stateDir };
}

async function cleanGatewayCron({ state, stateDir }: StartedGatewayCron): Promise<void> {
  try {
    await state.cron.stopAndDrain?.();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

describe("gateway cron stop-and-drain automation ownership", () => {
  beforeEach(() => {
    getRuntimeConfigMock.mockReset();
    stopAllMock.mockReset();
  });

  it("unregisters a stopped scheduler when stream draining fails and permits retry", async () => {
    stopAllMock.mockRejectedValueOnce(new Error("stream drain failed"));
    stopAllMock.mockResolvedValue(undefined);
    const original = await startGatewayCron("failed");

    try {
      expect(sessionHasAutomation("agent:main:main", original.cfg)).toBe(true);

      await expect(original.state.cron.stopAndDrain?.()).rejects.toThrow("stream drain failed");

      expect(sessionHasAutomation("agent:main:main", original.cfg)).toBe(false);
      await expect(original.state.cron.stopAndDrain?.()).resolves.toBeUndefined();
      expect(stopAllMock).toHaveBeenCalledTimes(2);
      expect(sessionHasAutomation("agent:main:main", original.cfg)).toBe(false);
    } finally {
      await cleanGatewayCron(original);
    }
  });

  it("does not unregister a replacement scheduler when a stale drain fails", async () => {
    const pendingDrain = createDeferred();
    stopAllMock.mockImplementationOnce(() => pendingDrain.promise);
    stopAllMock.mockResolvedValue(undefined);
    const original = await startGatewayCron("stale");
    let replacement: StartedGatewayCron | undefined;

    try {
      expect(sessionHasAutomation("agent:main:main", original.cfg)).toBe(true);

      const staleDrain = original.state.cron.stopAndDrain?.();
      if (!staleDrain) {
        throw new Error("expected cron stop-and-drain");
      }

      replacement = await startGatewayCron("replacement");
      expect(sessionHasAutomation("agent:main:main", replacement.cfg)).toBe(true);

      const failedDrain = expect(staleDrain).rejects.toThrow("stream drain failed");
      pendingDrain.reject(new Error("stream drain failed"));
      await failedDrain;

      expect(sessionHasAutomation("agent:main:main", replacement.cfg)).toBe(true);
      await expect(original.state.cron.stopAndDrain?.()).resolves.toBeUndefined();
      expect(sessionHasAutomation("agent:main:main", replacement.cfg)).toBe(true);
    } finally {
      try {
        if (replacement) {
          await cleanGatewayCron(replacement);
        }
      } finally {
        await cleanGatewayCron(original);
      }
    }
  });
});
