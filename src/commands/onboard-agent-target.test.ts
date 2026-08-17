// Onboarding target tests keep workspace, auth directory, and sessions on one agent owner.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import type { RuntimeEnv } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  applyOnboardingPrimaryModel,
  ensureOnboardingAgentWorkspace,
  resolveOnboardingAgentTarget,
} from "./onboard-agent-target.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("onboarding agent target", () => {
  it("preserves an uppercase authored entry key when applying the primary model", () => {
    const config = {
      agents: {
        ownership: "explicit" as const,
        entries: {
          MAIN: { model: "openai/old" },
        },
      },
    };
    const target = resolveOnboardingAgentTarget(config, "main");

    expect(applyOnboardingPrimaryModel(config, target, "openai/new").agents?.entries).toEqual({
      MAIN: {
        model: { primary: "openai/new" },
        models: { "openai/new": {} },
      },
    });
  });

  it("uses the retained compatibility owner after the marker is removed", () => {
    const config = retainLegacyDefaultAgentId(
      { agents: { entries: { main: {}, ops: { workspace: "/srv/ops" } } } },
      "ops",
    );

    expect(resolveOnboardingAgentTarget(config)).toMatchObject({
      agentId: "ops",
      workspaceDir: "/srv/ops",
    });
  });

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
