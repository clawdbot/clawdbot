import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildTerminalEnv,
  createTerminalLaunchPolicy,
  resolveTerminalSpawnPlan,
} from "./launch.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const disabled: OpenClawConfig = { gateway: { terminal: { enabled: false } } };

describe("createTerminalLaunchPolicy", () => {
  it("is enabled by default and fails closed when disabled, sandboxed, or unknown-agent", () => {
    expect(createTerminalLaunchPolicy({}).isEnabled()).toBe(true);
    expect(createTerminalLaunchPolicy(disabled).resolve()).toEqual({
      ok: false,
      block: { kind: "disabled" },
    });

    const sandboxed = createTerminalLaunchPolicy({
      gateway: { terminal: { enabled: true } },
      agents: { defaults: { sandbox: { mode: "all" } } },
    });
    expect(sandboxed.resolve()).toMatchObject({
      ok: false,
      block: { kind: "sandboxed", mode: "all" },
    });

    const configured = createTerminalLaunchPolicy({
      gateway: { terminal: { enabled: true } },
      agents: { list: [{ id: "locked", sandbox: { mode: "all" } }] },
    });
    expect(configured.resolve("ghost")).toEqual({
      ok: false,
      block: { kind: "unknown-agent", agentId: "ghost" },
    });
  });

  it("requires an explicit terminal owner in explicit multi-agent fleets", () => {
    const policy = createTerminalLaunchPolicy({
      agents: {
        ownership: "explicit",
        entries: { main: {}, research: {} },
      },
    });

    expect(policy.resolve()).toMatchObject({
      ok: false,
      block: {
        kind: "owner-required",
        message: expect.stringContaining("no explicit owner"),
      },
    });
    expect(policy.resolve("research")).toMatchObject({
      ok: true,
      plan: { agentId: "research" },
    });
  });

  it("applies restart-bound revocations without granting access early", () => {
    const enabled = {
      gateway: { port: 18789, terminal: { enabled: true } },
    } as OpenClawConfig;
    const policy = createTerminalLaunchPolicy(enabled);

    policy.prepareConfig(
      { gateway: { port: 18790, terminal: { enabled: false } } },
      { restartPending: true },
    );
    policy.prepareConfig(enabled, { restartPending: true });
    expect(policy.isEnabled()).toBe(false);
    expect(policy.resolve()).toEqual({ ok: false, block: { kind: "disabled" } });

    policy.prepareConfig(
      { gateway: { port: 18790, terminal: { enabled: true, shell: "/bin/new-shell" } } },
      { restartPending: false },
    );
    policy.commitConfig();
    policy.acceptConfig({ retireRejectedRestart: false });
    expect(policy.isEnabled()).toBe(false);
    expect(policy.resolve()).toEqual({ ok: false, block: { kind: "disabled" } });

    const disabledPolicy = createTerminalLaunchPolicy(disabled);
    disabledPolicy.prepareConfig(enabled, { restartPending: true });
    expect(disabledPolicy.isEnabled()).toBe(false);
    expect(disabledPolicy.resolve()).toEqual({ ok: false, block: { kind: "disabled" } });
  });

  it("preserves sandbox revocations across later restart-bound updates", () => {
    const workspace = tempDirs.make("term-policy-agent-");
    const baseConfig: OpenClawConfig = {
      gateway: { terminal: { enabled: true } },
      agents: { defaults: { workspace }, list: [{ id: "ops" }] },
    };
    const policy = createTerminalLaunchPolicy(baseConfig);
    policy.prepareConfig(
      {
        ...baseConfig,
        agents: {
          defaults: { workspace },
          list: [{ id: "ops", sandbox: { mode: "all" } }],
        },
      },
      { restartPending: true },
    );
    policy.prepareConfig(baseConfig, { restartPending: true });

    const resolved = policy.resolve("ops");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.block.kind).toBe("sandboxed");
    }
  });

  it("keeps restart and commit restrictions isolated across agents", () => {
    const baseConfig: OpenClawConfig = {
      agents: { ownership: "explicit", list: [{ id: "alpha" }, { id: "beta" }] },
    };
    const policy = createTerminalLaunchPolicy(baseConfig);

    policy.prepareConfig(
      {
        agents: {
          ownership: "explicit",
          list: [{ id: "alpha", sandbox: { mode: "all" } }, { id: "beta" }],
        },
      },
      { restartPending: true },
    );
    policy.prepareConfig(
      {
        agents: {
          ownership: "explicit",
          list: [{ id: "alpha" }, { id: "beta", sandbox: { mode: "all" } }],
        },
      },
      { restartPending: false },
    );

    expect(policy.resolve("alpha").ok).toBe(false);
    expect(policy.resolve("beta").ok).toBe(false);

    policy.acceptConfig({ retireRejectedRestart: false });
    expect(policy.resolve("alpha").ok).toBe(false);
    expect(policy.resolve("beta").ok).toBe(true);

    policy.acceptConfig({ retireRejectedRestart: true });
    expect(policy.resolve("alpha").ok).toBe(true);
  });

  it.each(["sandboxed", "unknown-agent"] as const)(
    "retains a pending %s restriction when hot-enabling an initially disabled terminal",
    (kind) => {
      const initial: OpenClawConfig = {
        ...disabled,
        agents: { ownership: "explicit", entries: { ops: {}, other: {} } },
      };
      const policy = createTerminalLaunchPolicy(initial);
      policy.prepareConfig(
        {
          gateway: { ...initial.gateway, port: 18790 },
          agents: {
            ...initial.agents,
            entries:
              kind === "sandboxed"
                ? { ops: { sandbox: { mode: "all" } }, other: {} }
                : { other: {} },
          },
        },
        { restartPending: true },
      );
      policy.acceptConfig({ retireRejectedRestart: false });
      policy.prepareConfig(
        { ...initial, gateway: { port: 18790, terminal: { enabled: true } } },
        { restartPending: false },
      );
      policy.commitConfig();
      policy.acceptConfig({ retireRejectedRestart: false });

      expect(policy.isEnabled()).toBe(true);
      expect(policy.resolve("ops")).toMatchObject({ ok: false, block: { kind } });
      expect(policy.resolve("other").ok).toBe(true);
    },
  );

  it("keeps current launch details until a restart-bound change takes effect", () => {
    const workspace = tempDirs.make("term-policy-");
    const policy = createTerminalLaunchPolicy({
      gateway: { terminal: { enabled: true, shell: "/bin/old-shell" } },
      agents: { defaults: { workspace } },
    });

    policy.prepareConfig(
      {
        gateway: { terminal: { enabled: true, shell: "/bin/new-shell" } },
        agents: { defaults: { workspace } },
      },
      { restartPending: true },
    );

    const resolved = policy.resolve();
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.plan.shell).toBe("/bin/old-shell");
    }

    policy.prepareConfig(
      {
        gateway: { terminal: { enabled: true, shell: "/bin/new-shell" } },
        agents: { defaults: { workspace, sandbox: { mode: "all" } } },
      },
      { restartPending: false },
    );
    const tightened = policy.resolve();
    expect(tightened.ok).toBe(false);
    if (!tightened.ok) {
      expect(tightened.block.kind).toBe("sandboxed");
    }
  });

  it.each([false, true])(
    "publishes shell changes only at hot commit with pending restart=%s",
    (restartPending) => {
      const initial: OpenClawConfig = {
        gateway: { terminal: { enabled: true, shell: "/bin/old-shell" } },
      };
      const policy = createTerminalLaunchPolicy(initial);
      const originalLaunch = policy.resolve();
      if (restartPending) {
        policy.prepareConfig(
          { ...initial, gateway: { ...initial.gateway, port: 18790 } },
          {
            restartPending: true,
          },
        );
      }
      const nextConfig: OpenClawConfig = {
        gateway: { terminal: { enabled: true, shell: "/bin/new-shell" } },
      };
      policy.prepareConfig(nextConfig, { restartPending: false });
      expect(policy.resolve()).toMatchObject({ ok: true, plan: { shell: "/bin/old-shell" } });

      policy.commitConfig();
      expect(policy.resolve()).toMatchObject({ ok: true, plan: { shell: "/bin/new-shell" } });
      expect(originalLaunch).toMatchObject({ ok: true, plan: { shell: "/bin/old-shell" } });

      policy.prepareConfig(
        { gateway: { terminal: { shell: "/bin/rejected-shell" } } },
        {
          restartPending: false,
        },
      );
      policy.acceptConfig({ retireRejectedRestart: false });
      policy.commitConfig();
      expect(policy.resolve()).toMatchObject({ ok: true, plan: { shell: "/bin/new-shell" } });

      const defaults = createTerminalLaunchPolicy({}).resolve();
      policy.prepareConfig({}, { restartPending: false });
      policy.commitConfig();
      expect(policy.resolve()).toEqual(defaults);
    },
  );

  it("applies non-restart sandbox policy changes immediately", () => {
    const policy = createTerminalLaunchPolicy({
      gateway: { terminal: { enabled: true } },
    });
    policy.prepareConfig(
      {
        gateway: { terminal: { enabled: true } },
        agents: { defaults: { sandbox: { mode: "all" } } },
      },
      { restartPending: false },
    );

    const blocked = policy.resolve();
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.block.kind).toBe("sandboxed");
    }
  });

  it("does not grant a non-restart policy relaxation before commit", () => {
    const policy = createTerminalLaunchPolicy({
      gateway: { terminal: { enabled: true } },
      agents: { defaults: { sandbox: { mode: "all" } } },
    });
    policy.prepareConfig(
      {
        gateway: { terminal: { enabled: true } },
        agents: { defaults: { sandbox: { mode: "off" } } },
      },
      { restartPending: false },
    );
    expect(policy.resolve().ok).toBe(false);

    policy.commitConfig();
    expect(policy.resolve().ok).toBe(true);
  });

  it("retains failed hot-reload revocations until a later commit succeeds", () => {
    const baseConfig: OpenClawConfig = {
      gateway: { terminal: { enabled: true } },
      agents: { defaults: { sandbox: { mode: "off" } } },
    };
    const policy = createTerminalLaunchPolicy(baseConfig);
    policy.prepareConfig(
      {
        gateway: { terminal: { enabled: true } },
        agents: { defaults: { sandbox: { mode: "all" } } },
      },
      { restartPending: false },
    );
    // Simulate a failed hot reload, followed by a relaxation that has not
    // succeeded yet. The first attempt's revocation must remain in force.
    policy.prepareConfig(baseConfig, { restartPending: false });
    expect(policy.resolve().ok).toBe(false);

    policy.commitConfig();
    expect(policy.resolve().ok).toBe(true);

    const restartPolicy = createTerminalLaunchPolicy(baseConfig);
    restartPolicy.prepareConfig(
      {
        ...baseConfig,
        agents: { defaults: { sandbox: { mode: "all" } } },
      },
      { restartPending: false },
    );
    restartPolicy.prepareConfig(baseConfig, { restartPending: true });
    expect(restartPolicy.resolve().ok).toBe(false);
    restartPolicy.acceptConfig({ retireRejectedRestart: false });
    restartPolicy.commitConfig();
    expect(restartPolicy.resolve().ok).toBe(true);
  });

  it("releases a rejected restart restriction after an accepted revert", () => {
    const baseConfig: OpenClawConfig = {
      gateway: { terminal: { enabled: true } },
    };
    const policy = createTerminalLaunchPolicy(baseConfig);

    policy.prepareConfig(disabled, { restartPending: true });
    policy.prepareConfig(
      {
        ...baseConfig,
        agents: { defaults: { sandbox: { mode: "all" } } },
      },
      { restartPending: false },
    );
    policy.commitConfig();
    expect(policy.isEnabled()).toBe(false);

    policy.acceptConfig({ retireRejectedRestart: true });
    policy.commitConfig();
    expect(policy.isEnabled()).toBe(true);
  });

  it("commits a newer hot candidate after a rejected restart is retired", () => {
    const baseConfig: OpenClawConfig = {
      gateway: { terminal: { enabled: true } },
      agents: { defaults: { sandbox: { mode: "all" } } },
    };
    const policy = createTerminalLaunchPolicy(baseConfig);

    policy.prepareConfig(disabled, { restartPending: true });
    policy.prepareConfig(
      {
        gateway: { terminal: { enabled: true } },
        agents: { defaults: { sandbox: { mode: "off" } } },
      },
      { restartPending: false },
    );
    policy.commitConfig();
    expect(policy.resolve().ok).toBe(false);

    policy.acceptConfig({ retireRejectedRestart: true });
    policy.commitConfig();
    expect(policy.resolve().ok).toBe(true);
  });

  it("retires failed hot candidates without clearing committed restart restrictions", () => {
    const baseConfig: OpenClawConfig = {
      gateway: { terminal: { enabled: true } },
      agents: { defaults: { sandbox: { mode: "off" } } },
    };
    const policy = createTerminalLaunchPolicy(baseConfig);

    policy.prepareConfig(
      {
        ...baseConfig,
        agents: { defaults: { sandbox: { mode: "all" } } },
      },
      { restartPending: false },
    );
    expect(policy.resolve().ok).toBe(false);

    policy.acceptConfig({ retireRejectedRestart: false });
    policy.commitConfig();
    expect(policy.resolve().ok).toBe(true);

    const skippedPolicy = createTerminalLaunchPolicy({
      ...baseConfig,
      agents: { defaults: { sandbox: { mode: "all" } } },
    });
    skippedPolicy.prepareConfig(baseConfig, { restartPending: false });
    skippedPolicy.acceptConfig({ retireRejectedRestart: false });
    skippedPolicy.commitConfig();
    expect(skippedPolicy.resolve().ok).toBe(false);

    const pendingPolicy = createTerminalLaunchPolicy(baseConfig);
    pendingPolicy.prepareConfig(baseConfig, { restartPending: true });
    pendingPolicy.prepareConfig(
      {
        ...baseConfig,
        agents: { defaults: { sandbox: { mode: "all" } } },
      },
      { restartPending: false },
    );
    expect(pendingPolicy.resolve().ok).toBe(false);
    pendingPolicy.acceptConfig({ retireRejectedRestart: false });
    pendingPolicy.commitConfig();
    expect(pendingPolicy.resolve().ok).toBe(true);

    const appliedPendingPolicy = createTerminalLaunchPolicy(baseConfig);
    appliedPendingPolicy.prepareConfig(baseConfig, { restartPending: true });
    appliedPendingPolicy.prepareConfig(
      {
        ...baseConfig,
        agents: { defaults: { sandbox: { mode: "all" } } },
      },
      { restartPending: false },
    );
    appliedPendingPolicy.commitConfig();
    appliedPendingPolicy.acceptConfig({ retireRejectedRestart: false });
    appliedPendingPolicy.commitConfig();
    expect(appliedPendingPolicy.resolve().ok).toBe(false);
    appliedPendingPolicy.prepareConfig(baseConfig, { restartPending: false });
    appliedPendingPolicy.commitConfig();
    appliedPendingPolicy.acceptConfig({ retireRejectedRestart: false });
    appliedPendingPolicy.commitConfig();
    expect(appliedPendingPolicy.resolve().ok).toBe(true);

    policy.prepareConfig(disabled, { restartPending: true });
    policy.acceptConfig({ retireRejectedRestart: false });
    policy.commitConfig();
    expect(policy.isEnabled()).toBe(false);
  });

  it.each([false, true])(
    "commits hot enablement and keeps failed disable restrictions until commit with pending restart=%s",
    (restartPending) => {
      const policy = createTerminalLaunchPolicy(disabled);
      const disabledConfig: OpenClawConfig = {
        gateway: { ...(restartPending ? { port: 18790 } : {}), terminal: { enabled: false } },
      };
      const enabledConfig: OpenClawConfig = {
        gateway: { ...disabledConfig.gateway, terminal: { enabled: true, shell: "/bin/sh" } },
      };
      if (restartPending) {
        policy.prepareConfig(disabledConfig, { restartPending: true });
        policy.acceptConfig({ retireRejectedRestart: false });
      }
      policy.prepareConfig(enabledConfig, { restartPending: false });
      expect(policy.isEnabled()).toBe(false);
      expect(policy.resolve()).toEqual({ ok: false, block: { kind: "disabled" } });

      policy.commitConfig();
      policy.acceptConfig({ retireRejectedRestart: false });
      expect(policy.isEnabled()).toBe(true);
      expect(policy.resolve()).toMatchObject({ ok: true, plan: { shell: "/bin/sh" } });

      policy.prepareConfig(disabledConfig, { restartPending: false });
      expect(policy.isEnabled()).toBe(false);
      expect(policy.resolve()).toEqual({ ok: false, block: { kind: "disabled" } });
      // A failed disable cannot grant access through an uncommitted relaxation.
      policy.prepareConfig(enabledConfig, { restartPending: false });
      expect(policy.isEnabled()).toBe(false);
      expect(policy.resolve()).toEqual({ ok: false, block: { kind: "disabled" } });
      policy.commitConfig();
      policy.acceptConfig({ retireRejectedRestart: false });
      expect(policy.isEnabled()).toBe(true);
      expect(policy.resolve().ok).toBe(true);

      policy.prepareConfig(disabledConfig, { restartPending: false });
      policy.commitConfig();
      policy.acceptConfig({ retireRejectedRestart: false });
      expect(policy.isEnabled()).toBe(false);
      expect(policy.resolve()).toEqual({ ok: false, block: { kind: "disabled" } });
    },
  );
});

describe("buildTerminalEnv", () => {
  it("carries the base env, defaults TERM, and marks the terminal", () => {
    const env = buildTerminalEnv({ PATH: "/usr/bin", FOO: "bar" });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.FOO).toBe("bar");
    expect(env.TERM).toBe("xterm-256color");
    expect(env.OPENCLAW_TERMINAL).toBe("1");
  });

  it("preserves an existing TERM", () => {
    const env = buildTerminalEnv({ TERM: "screen-256color" });
    expect(env.TERM).toBe("screen-256color");
  });
});

describe("resolveTerminalSpawnPlan", () => {
  it("quotes every command argument for a login shell", () => {
    const plan = resolveTerminalSpawnPlan({
      agentId: "main",
      cwd: "/work",
      shell: "/bin/zsh",
      args: ["-l"],
      initialCommand: ["codex", "resume", "a b;$HOME", "it's"],
    });
    expect(plan).toMatchObject({
      shell: "/bin/zsh",
      args: ["-il", "-c", "'codex' 'resume' 'a b;$HOME' 'it'\"'\"'s'"],
    });
  });

  it("uses a valid cwd override and falls back to home for a missing override", () => {
    const cwd = tempDirs.make("terminal-resume-cwd-");
    const base = {
      agentId: "main",
      cwd: "/missing/base",
      shell: "/bin/sh",
      args: [],
      initialCommand: ["claude", "--resume", "id"],
    };
    expect(resolveTerminalSpawnPlan({ ...base, cwdOverride: cwd }).cwd).toBe(cwd);
    expect(
      resolveTerminalSpawnPlan(
        { ...base, cwdOverride: "/definitely/missing" },
        { env: { HOME: "/fallback/home" } },
      ).cwd,
    ).toBe("/fallback/home");
  });

  it("spawns the resume executable directly on Windows", () => {
    expect(
      resolveTerminalSpawnPlan(
        {
          agentId: "main",
          cwd: "/work",
          shell: "cmd.exe",
          args: [],
          initialCommand: ["codex.exe", "resume", "thread"],
        },
        { platform: "win32" },
      ),
    ).toMatchObject({ shell: "codex.exe", args: ["resume", "thread"] });
  });
});
