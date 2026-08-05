// Onboarding target tests keep workspace, auth directory, and sessions on one agent owner.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { RuntimeEnv } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  ensureOnboardingAgentWorkspace,
  resolveOnboardingAgentTarget,
} from "./onboard-agent-target.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("onboarding agent target", () => {
  it("provisions the configured default agent workspace and sessions", async () => {
    const stateDir = tempDirs.make("openclaw-onboard-target-");
    const globalWorkspace = path.join(stateDir, "global-workspace");
    const opsWorkspace = path.join(stateDir, "ops-workspace");
    const runtime = { log: vi.fn() } as unknown as RuntimeEnv;

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const config = {
        agents: {
          defaults: { workspace: globalWorkspace },
          entries: { ops: { default: true, workspace: opsWorkspace } },
        },
      };
      const target = resolveOnboardingAgentTarget(config);

      expect(target).toEqual({
        agentId: "ops",
        agentDir: path.join(stateDir, "agents", "ops", "agent"),
        workspaceDir: opsWorkspace,
      });
      expect(resolveOnboardingAgentTarget(config, " OPS ")).toEqual(target);
      await ensureOnboardingAgentWorkspace(target, runtime, { skipBootstrap: true });

      expect((await fs.stat(opsWorkspace)).isDirectory()).toBe(true);
      expect((await fs.stat(path.join(stateDir, "agents", "ops", "sessions"))).isDirectory()).toBe(
        true,
      );
      await expect(fs.access(globalWorkspace)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs.access(path.join(stateDir, "agents", "main", "sessions")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
