// Onboard config tests cover workspace, bootstrap, and local setup config mutations.
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyLocalSetupWorkspaceConfig,
  resolveOnboardingWorkspaceConflict,
} from "./onboard-config.js";

describe("applyLocalSetupWorkspaceConfig", () => {
  it("leaves dmScope unset when not configured", () => {
    const baseConfig: OpenClawConfig = {};
    const result = applyLocalSetupWorkspaceConfig(baseConfig, "/tmp/workspace");

    expect(result.session?.dmScope).toBeUndefined();
    expect(result).not.toHaveProperty("session.dmScope");
    expect(result.gateway?.mode).toBe("local");
    expect(result.agents?.defaults?.workspace).toBe("/tmp/workspace");
    expect(result.tools?.profile).toBe("coding");
  });

  it("preserves existing dmScope when already configured", () => {
    const baseConfig: OpenClawConfig = {
      session: {
        dmScope: "main",
      },
    };
    const result = applyLocalSetupWorkspaceConfig(baseConfig, "/tmp/workspace");

    expect(result.session?.dmScope).toBe("main");
  });

  it("preserves explicit non-main dmScope values", () => {
    const baseConfig: OpenClawConfig = {
      session: {
        dmScope: "per-account-channel-peer",
      },
    };
    const result = applyLocalSetupWorkspaceConfig(baseConfig, "/tmp/workspace");

    expect(result.session?.dmScope).toBe("per-account-channel-peer");
  });

  it("preserves an explicit tools.profile when already configured", () => {
    const baseConfig: OpenClawConfig = {
      tools: {
        profile: "full",
      },
    };
    const result = applyLocalSetupWorkspaceConfig(baseConfig, "/tmp/workspace");

    expect(result.tools?.profile).toBe("full");
  });

  it("preserves agents.list and bindings on onboard rerun (openclaw#84692)", () => {
    const baseConfig: OpenClawConfig = {
      agents: {
        list: [
          { id: "alpha", model: "anthropic/claude-3-5-sonnet" },
          { id: "beta", model: "openai/gpt-4o" },
        ],
      },
      bindings: [
        {
          type: "route",
          agentId: "alpha",
          match: { channel: "discord", peer: { kind: "direct", id: "user-1" } },
        },
      ],
    } as OpenClawConfig;

    const result = applyLocalSetupWorkspaceConfig(baseConfig, "/tmp/workspace");

    expect(result.agents?.list).toHaveLength(2);
    expect(result.agents?.list?.map((a) => a.id)).toEqual(["alpha", "beta"]);
    expect(result.bindings).toEqual(baseConfig.bindings);
  });

  it("keeps fresh-install workspace writes unchanged", () => {
    const result = applyLocalSetupWorkspaceConfig({}, "/tmp/new-workspace", {
      env: { HOME: "/tmp/fresh-home", OPENCLAW_STATE_DIR: "/tmp/fresh-state" },
    });

    expect(result.agents?.defaults?.workspace).toBe("/tmp/new-workspace");
  });

  it("preserves the current workspace when an agent roster exists", () => {
    const baseConfig: OpenClawConfig = {
      agents: {
        defaults: { workspace: "/tmp/current-workspace" },
        list: [{ id: "main" }, { id: "ops" }],
      },
    };

    const conflict = resolveOnboardingWorkspaceConflict(baseConfig, "/tmp/requested-workspace");
    const result = applyLocalSetupWorkspaceConfig(baseConfig, "/tmp/requested-workspace");

    expect(conflict).toEqual({
      currentWorkspaceDir: "/tmp/current-workspace",
      requestedWorkspaceDir: "/tmp/requested-workspace",
    });
    expect(result.agents?.defaults?.workspace).toBe("/tmp/current-workspace");
  });

  it("does not materialize a fleet default for an existing roster", () => {
    const env = { HOME: "/tmp/fleet-home", OPENCLAW_STATE_DIR: "/tmp/fleet-state" };
    const baseConfig: OpenClawConfig = {
      agents: { list: [{ id: "main" }, { id: "ops" }] },
    };

    const result = applyLocalSetupWorkspaceConfig(
      baseConfig,
      "/tmp/fleet-home/.openclaw/workspace",
      { env },
    );

    expect(result.agents?.defaults?.workspace).toBeUndefined();
  });

  it("keeps fresh-install workspace writes when only inference state exists on disk", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-onboard-state-"));
    try {
      await fs.mkdir(path.join(stateDir, "agents", "main", "sessions"), { recursive: true });
      const env = { HOME: stateDir, OPENCLAW_STATE_DIR: stateDir };

      const result = applyLocalSetupWorkspaceConfig({}, "/tmp/requested-workspace", {
        env,
      });

      expect(result.agents?.defaults?.workspace).toBe("/tmp/requested-workspace");
      const rerun = applyLocalSetupWorkspaceConfig(
        { agents: { defaults: { workspace: "/tmp/current-workspace" } } },
        "/tmp/requested-workspace",
        { env },
      );
      expect(rerun.agents?.defaults?.workspace).toBe("/tmp/current-workspace");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("fails closed when existing agent state cannot be inspected", () => {
    const read = vi.spyOn(nodeFs, "readdirSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });
    try {
      const result = applyLocalSetupWorkspaceConfig(
        { agents: { defaults: { workspace: "/tmp/current-workspace" } } },
        "/tmp/requested-workspace",
        {
          env: { HOME: "/tmp/unreadable-home", OPENCLAW_STATE_DIR: "/tmp/unreadable-state" },
        },
      );
      expect(result.agents?.defaults?.workspace).toBe("/tmp/current-workspace");
    } finally {
      read.mockRestore();
    }
  });

  it("allows an explicitly confirmed workspace move", () => {
    const baseConfig: OpenClawConfig = {
      agents: {
        defaults: { workspace: "/tmp/current-workspace" },
        list: [{ id: "main" }],
      },
    };

    const result = applyLocalSetupWorkspaceConfig(baseConfig, "/tmp/requested-workspace", {
      allowWorkspaceChange: true,
    });

    expect(result.agents?.defaults?.workspace).toBe("/tmp/requested-workspace");
  });
});
