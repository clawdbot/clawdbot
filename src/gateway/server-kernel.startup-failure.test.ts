// #120332 round 53 (P2): a PRE-LIFECYCLE startup failure must not leave landed-ownership
// state behind. Kernel state prep activates the process-global plugin registry and pins the
// runtime config snapshot before the lifecycle exists; without clearing both, later validation
// (or a same-process retry) treats registrations from a Gateway that never started as landed
// channel owners and applies stale schemas.
import { describe, expect, it, vi } from "vitest";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { createGatewayKernel } from "./server-kernel.js";

// #120332 round 55 (P2): teardown ORDER matters — the registry retires first (plugin-host
// cleanup still reads runtime config and secrets snapshots, as in normal shutdown), snapshots
// scrub afterwards.
const teardownOrder = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("../plugins/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/runtime.js")>();
  return {
    ...actual,
    clearActivePluginRegistry: async () => {
      teardownOrder.calls.push("registry");
      return actual.clearActivePluginRegistry();
    },
  };
});

vi.mock("../secrets/runtime-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../secrets/runtime-state.js")>();
  return {
    ...actual,
    clearSecretsRuntimeSnapshotState: () => {
      teardownOrder.calls.push("secrets");
      return actual.clearSecretsRuntimeSnapshotState();
    },
  };
});

vi.mock("./server-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-lifecycle.js")>();
  return {
    ...actual,
    prepareGatewayLifecycle: () => {
      throw new Error("fixture pre-lifecycle failure");
    },
  };
});

describe("createGatewayKernel pre-lifecycle failure", () => {
  it("clears the activated plugin registry and runtime config snapshot", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "gateway-kernel-prelifecycle-failure",
      layout: "home",
      env: {
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        VITEST: "1",
      },
    });
    const token = "gateway-kernel-prelifecycle-token";
    await state.writeConfig({
      gateway: {
        auth: { mode: "token", token },
        controlUi: { enabled: false },
        port,
      },
    });
    state.applyEnv();
    try {
      await expect(
        createGatewayKernel(port, {
          auth: { mode: "token", token },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        }),
      ).rejects.toThrow("fixture pre-lifecycle failure");
      expect(getActivePluginRegistry()).toBeNull();
      expect(getRuntimeConfigSnapshot()).toBeNull();
      // Registry teardown ran BEFORE the snapshot scrub.
      expect(teardownOrder.calls.lastIndexOf("registry")).toBeGreaterThanOrEqual(0);
      expect(teardownOrder.calls.lastIndexOf("registry")).toBeLessThan(
        teardownOrder.calls.lastIndexOf("secrets"),
      );
    } finally {
      await state.cleanup();
    }
  });
});
