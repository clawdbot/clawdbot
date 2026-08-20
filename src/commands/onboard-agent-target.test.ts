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
  applyAgentModelDefaults,
  ensureOnboardingAgentWorkspace,
  resolveOnboardingAgentTarget,
  resolveSystemAgentOnboardingTarget,
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

  it("resolves shared system-agent setup to the configured system agent on a legacy roster", () => {
    const config = {
      agents: {
        defaults: {
          workspace: "/srv/global",
          systemAgent: { agentId: "main" },
        },
        entries: {
          main: { workspace: "/srv/main" },
          ops: { default: true, workspace: "/srv/ops" },
        },
      },
    };

    expect(resolveOnboardingAgentTarget(config)).toMatchObject({
      agentId: "ops",
      workspaceDir: "/srv/ops",
    });
    expect(resolveSystemAgentOnboardingTarget(config)).toMatchObject({
      agentId: "main",
      workspaceDir: "/srv/main",
    });
  });

  it("keeps explicit agent model mutations on the system-agent entry", () => {
    const config = {
      agents: {
        ownership: "explicit" as const,
        defaults: { model: { primary: "openai/global" } },
        entries: {
          main: {},
          ops: { model: { primary: "openai/old" } },
        },
      },
    };
    const target = resolveSystemAgentOnboardingTarget({
      ...config,
      agents: {
        ...config.agents,
        defaults: { systemAgent: { agentId: "ops" } },
      },
    });

    const updated = applyAgentModelDefaults(config, target, (projected) => ({
      ...projected,
      agents: {
        ...projected.agents,
        defaults: {
          ...projected.agents?.defaults,
          model: { primary: "openai/new" },
        },
      },
    }));

    expect(updated.agents?.entries?.ops?.model).toEqual({ primary: "openai/new" });
    expect(updated.agents?.defaults?.model).toEqual({ primary: "openai/global" });
    expect(updated.agents?.entries?.main?.model).toBeUndefined();
  });

  it("preserves the authored key when projecting explicit agent defaults", () => {
    const config = {
      agents: {
        ownership: "explicit" as const,
        entries: { main: {}, OPS: { model: { primary: "old/model" } } },
      },
    };
    const target = resolveOnboardingAgentTarget(config, "ops");
    const updated = applyAgentModelDefaults(config, target, (projected) => ({
      ...projected,
      agents: {
        ...projected.agents,
        defaults: { ...projected.agents?.defaults, model: { primary: "new/model" } },
      },
    }));

    expect(updated.agents?.entries?.OPS?.model).toEqual({ primary: "new/model" });
    expect(updated.agents?.entries?.ops).toBeUndefined();
  });

  it("preserves every list-form agent when applying the primary model", () => {
    const config = {
      agents: {
        ownership: "explicit" as const,
        list: [
          { id: "main", name: "Main", model: { primary: "openai/main" } },
          {
            id: "OPS",
            name: "Operations",
            model: { primary: "openai/old", fallbacks: ["openai/fallback"] },
            models: { "openai/old": { alias: "Old" } },
          },
        ],
      },
    };
    const target = resolveOnboardingAgentTarget(config, "ops");

    const updated = applyOnboardingPrimaryModel(config, target, "openai/new");

    expect(updated.agents?.list).toBeUndefined();
    expect(updated.agents?.entries).toEqual({
      main: { name: "Main", model: { primary: "openai/main" } },
      OPS: {
        name: "Operations",
        model: { primary: "openai/new", fallbacks: ["openai/fallback"] },
        models: { "openai/old": { alias: "Old" }, "openai/new": {} },
      },
    });
  });

  it("preserves every list-form agent when projecting model policy", () => {
    const config = {
      agents: {
        ownership: "explicit" as const,
        list: [
          { id: "main", modelPolicy: { allow: ["openai/main"] } },
          { id: "ops", modelPolicy: { allow: ["openai/old"] } },
        ],
      },
    };
    const target = resolveOnboardingAgentTarget(config, "ops");

    const updated = applyAgentModelDefaults(config, target, (projected) => ({
      ...projected,
      agents: {
        ...projected.agents,
        defaults: {
          ...projected.agents?.defaults,
          modelPolicy: { allow: ["openai/new"] },
        },
      },
    }));

    expect(updated.agents?.list).toBeUndefined();
    expect(updated.agents?.entries).toEqual({
      main: { modelPolicy: { allow: ["openai/main"] } },
      ops: { modelPolicy: { allow: ["openai/new"] } },
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
