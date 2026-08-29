// Onboarding target tests keep workspace, auth directory, and sessions on one agent owner.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import { applyPrimaryModel } from "../plugins/provider-model-primary.js";
import type { RuntimeEnv } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  applyOnboardingPrimaryModel,
  applyAgentModelDefaults,
  ensureOnboardingAgentWorkspace,
  resolveOnboardingAgentTarget,
  resolveOnboardingSetupTarget,
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

  it("uses the system agent for explicit fleets without changing legacy ownership", () => {
    const entries = {
      main: { workspace: "/srv/main" },
      ops: { default: true, workspace: "/srv/ops" },
    };
    const pendingAgent = { name: "robby", workspaceDir: "/srv/robby" };

    expect(
      resolveOnboardingSetupTarget(
        {
          agents: {
            ownership: "explicit",
            defaults: { systemAgent: { agentId: "main" } },
            entries,
          },
        },
        pendingAgent,
      ),
    ).toMatchObject({ agentId: "main", workspaceDir: "/srv/main" });
    expect(
      resolveOnboardingSetupTarget(
        {
          agents: {
            ownership: "explicit",
            defaults: { systemAgent: { agentId: "main" } },
            entries: { main: { default: true } },
          },
        },
        pendingAgent,
      ),
    ).toMatchObject({ agentId: "main" });
    expect(resolveOnboardingSetupTarget({ agents: { entries } })).toMatchObject({
      agentId: "ops",
      workspaceDir: "/srv/ops",
    });
  });

  it("resolves a pending first agent without nesting the selected workspace", async () => {
    const stateDir = tempDirs.make("openclaw-pending-onboard-target-");
    const workspaceDir = path.join(stateDir, "requested-workspace");

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      for (const entries of [undefined, { main: {} }, { main: { default: true } }] as const) {
        const config = {
          agents: { defaults: { workspace: workspaceDir }, ...(entries ? { entries } : {}) },
        };

        expect(resolveOnboardingSetupTarget(config, { name: " Robby! ", workspaceDir })).toEqual({
          agentId: "robby",
          agentDir: path.join(stateDir, "agents", "robby", "agent"),
          workspaceDir,
        });
        expect(resolveOnboardingSetupTarget(config)).toMatchObject({
          agentId: "main",
          workspaceDir,
        });
      }
      expect(
        resolveOnboardingSetupTarget({
          agents: {
            entries: { main: { default: true, name: "Authored main", workspace: "/srv/main" } },
          },
        }),
      ).toMatchObject({ agentId: "main", workspaceDir: "/srv/main" });
      expect(
        resolveOnboardingSetupTarget({ agents: { entries: { main: { default: false } } } }),
      ).toMatchObject({ agentId: "main" });
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

  it("preserves unrelated global defaults while projecting model changes onto the authored agent", () => {
    const config = {
      agents: {
        ownership: "explicit" as const,
        defaults: {
          model: { primary: "openai/global" },
          models: { "openai/global": { alias: "Global" } },
          modelPolicy: { allow: ["openai/global"] },
        },
        entries: {
          main: { model: { primary: "openai/sibling" } },
          OPS: {
            model: { primary: "openai/old" },
            models: { "openai/old": { alias: "Old" } },
            modelPolicy: { allow: ["openai/old"] },
          },
        },
      },
    };
    const target = resolveOnboardingAgentTarget(config, "ops");

    const updated = applyAgentModelDefaults(config, target, (projected) => ({
      ...projected,
      plugins: { entries: { fixture: { enabled: true } } },
      agents: {
        ...projected.agents,
        defaults: {
          ...projected.agents?.defaults,
          model: { primary: "provider/selected" },
          models: {
            ...projected.agents?.defaults?.models,
            "provider/selected": { alias: "Selected" },
          },
          modelPolicy: { allow: ["provider/selected"] },
          mediaModels: { video: { primary: "media/video" } },
          experimental: { localModelLean: true },
        },
      },
    }));

    expect(updated.agents?.defaults).toEqual({
      model: { primary: "openai/global" },
      models: { "openai/global": { alias: "Global" } },
      modelPolicy: { allow: ["openai/global"] },
      mediaModels: { video: { primary: "media/video" } },
      experimental: { localModelLean: true },
    });
    expect(updated.agents?.entries).toEqual({
      main: { model: { primary: "openai/sibling" } },
      OPS: {
        model: { primary: "provider/selected" },
        models: {
          "openai/old": { alias: "Old" },
          "provider/selected": { alias: "Selected" },
        },
        modelPolicy: { allow: ["provider/selected"] },
      },
    });
    expect(updated.plugins?.entries?.fixture?.enabled).toBe(true);
  });

  it.each([
    { selectModel: false, expectedModel: undefined, expectedModels: undefined },
    {
      selectModel: true,
      expectedModel: { primary: "provider/selected" },
      expectedModels: { "provider/selected": {} },
    },
  ])("keeps fleet model aliases and policy inherited (select model: $selectModel)", (scenario) => {
    const config = {
      agents: {
        ownership: "explicit" as const,
        defaults: {
          model: "openai/global",
          models: { "openai/global": { alias: "Global" } },
          modelPolicy: { allow: ["openai/global"] },
        },
        entries: { main: { model: "openai/main" }, ops: {} },
      },
    };
    const target = resolveOnboardingAgentTarget(config, "ops");
    const updated = applyAgentModelDefaults(config, target, (projected) =>
      scenario.selectModel ? applyPrimaryModel(projected, "provider/selected") : projected,
    );

    expect(updated.agents?.defaults).toEqual(config.agents.defaults);
    expect(updated.agents?.entries?.ops?.model).toEqual(scenario.expectedModel);
    expect(updated.agents?.entries?.ops?.models).toEqual(scenario.expectedModels);
    expect(updated.agents?.entries?.ops?.modelPolicy).toBeUndefined();
    expect(updated.agents?.entries?.main?.model).toEqual("openai/main");
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
