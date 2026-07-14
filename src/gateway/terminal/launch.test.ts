import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildTerminalEnv, createTerminalLaunchPolicy } from "./launch.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("createTerminalLaunchPolicy", () => {
  it("fails closed when disabled, fully sandboxed, or given an unknown agent", () => {
    expect(createTerminalLaunchPolicy({}).resolve()).toEqual({
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

  it("applies restart-bound revocations without granting access early", () => {
    const enabled = {
      gateway: { terminal: { enabled: true } },
    } as OpenClawConfig;
    const policy = createTerminalLaunchPolicy(enabled);

    policy.prepareConfig({}, { restartPending: true });
    policy.prepareConfig(enabled, { restartPending: true });
    expect(policy.isEnabled()).toBe(false);
    expect(policy.resolve()).toEqual({ ok: false, block: { kind: "disabled" } });

    const disabledPolicy = createTerminalLaunchPolicy({});
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

    policy.prepareConfig({}, { restartPending: true });
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

    policy.prepareConfig({}, { restartPending: true });
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

    policy.prepareConfig({}, { restartPending: true });
    policy.acceptConfig({ retireRejectedRestart: false });
    policy.commitConfig();
    expect(policy.isEnabled()).toBe(false);
  });

  it("does not promote a terminal setting previously ignored by reload mode", () => {
    const disabledPolicy = createTerminalLaunchPolicy({});
    disabledPolicy.prepareConfig(
      {
        gateway: { terminal: { enabled: true } },
        agents: { defaults: { sandbox: { mode: "non-main" } } },
      },
      { restartPending: false },
    );
    disabledPolicy.commitConfig();
    expect(disabledPolicy.isEnabled()).toBe(false);
    expect(disabledPolicy.resolve()).toEqual({ ok: false, block: { kind: "disabled" } });

    const enabledPolicy = createTerminalLaunchPolicy({
      gateway: { terminal: { enabled: true, shell: "/bin/current-shell" } },
    });
    enabledPolicy.prepareConfig(
      {
        gateway: { terminal: { enabled: false, shell: "/bin/ignored-shell" } },
        agents: { defaults: { sandbox: { mode: "non-main" } } },
      },
      { restartPending: false },
    );
    enabledPolicy.commitConfig();
    expect(enabledPolicy.isEnabled()).toBe(true);
    const resolved = enabledPolicy.resolve();
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.plan.shell).toBe("/bin/current-shell");
    }

    enabledPolicy.prepareConfig({}, { restartPending: true });
    enabledPolicy.prepareConfig(
      {
        gateway: { terminal: { enabled: true } },
        agents: { defaults: { sandbox: { mode: "non-main" } } },
      },
      { restartPending: false },
    );
    expect(enabledPolicy.isEnabled()).toBe(false);
  });
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
