// Regression test for openclaw#22517: gateway startup must bump the skills
// snapshot version so persisted sessions re-resolve skills instead of
// silently reusing a stale (or empty) cached snapshot forever. See the
// minimal-boot smoke test's header comment for why a real (not mocked)
// gateway boot is used here.
import { describe, expect, it } from "vitest";
import {
  getSkillsSnapshotVersion,
  resetSkillsRefreshStateForTest,
} from "../skills/runtime/refresh-state.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";

const BOOT_BUDGET_MS = 90_000;

async function bootAndCloseMinimalGateway(label: string): Promise<number> {
  const port = await getFreePort();
  const state = await createOpenClawTestState({
    label,
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
  const token = `${label}-token`;
  await state.writeConfig({
    gateway: {
      auth: { mode: "token", token },
      controlUi: { enabled: false },
      port,
    },
  });
  state.applyEnv();
  try {
    const { startGatewayServer } = await import("./server.js");
    const server = await startGatewayServer(port, {
      auth: { mode: "token", token },
      bind: "loopback",
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });
    try {
      return getSkillsSnapshotVersion();
    } finally {
      await server.close({ reason: `${label} complete` });
    }
  } finally {
    await state.cleanup();
  }
}

describe("gateway startup skills snapshot version", () => {
  it(
    "bumps the skills snapshot version on every startup, including a same-process restart (openclaw#22517)",
    { timeout: BOOT_BUDGET_MS * 2 },
    async () => {
      // Simulates the in-memory state at the top of any real process
      // lifetime: a freshly initialized version counter, nothing bumped yet.
      resetSkillsRefreshStateForTest();
      const versionBeforeAnyStartup = getSkillsSnapshotVersion();

      // First boot: represents the version a session persists as its
      // skillsSnapshot.version the first time it's ever resolved.
      const versionAfterFirstBoot = await bootAndCloseMinimalGateway(
        "gateway-skills-snapshot-first-boot",
      );
      expect(versionAfterFirstBoot).toBeGreaterThan(versionBeforeAnyStartup);

      // Second boot in the SAME process and module registry -- this is
      // exactly what src/cli/gateway-cli/run-loop.ts does on a SIGUSR1
      // restart ("Keep process alive; SIGUSR1 triggers an in-process
      // restart (no supervisor required)"): it re-invokes the gateway
      // start function without a fresh Node process or module reimport.
      // A version bump that only fires once per process (e.g. gated
      // behind a "first boot" flag) would make this second boot's version
      // equal to the first, and this assertion would catch that: any
      // session that persisted `versionAfterFirstBoot` as its own
      // snapshot version must be judged stale after this second boot,
      // exactly as it would need to be after a real `openclaw gateway
      // restart` for a session created before that restart.
      const versionAfterSecondBoot = await bootAndCloseMinimalGateway(
        "gateway-skills-snapshot-second-boot",
      );
      expect(versionAfterSecondBoot).toBeGreaterThan(versionAfterFirstBoot);
    },
  );
});
