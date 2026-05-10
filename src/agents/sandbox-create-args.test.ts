import { describe, expect, it } from "vitest";
import { OPENCLAW_CLI_ENV_VALUE } from "../infra/openclaw-exec-env.js";
import { buildSandboxCreateArgs } from "./sandbox/docker.js";
import type { SandboxDockerConfig } from "./sandbox/types.js";

describe("buildSandboxCreateArgs", () => {
  function createSandboxConfig(
    overrides: Partial<SandboxDockerConfig> = {},
    binds?: string[],
  ): SandboxDockerConfig {
    return {
      image: "openclaw-sandbox:bookworm-slim",
      containerPrefix: "openclaw-sbx-",
      workdir: "/workspace",
      readOnlyRoot: false,
      tmpfs: [],
      network: "none",
      capDrop: [],
      ...(binds ? { binds } : {}),
      ...overrides,
    };
  }

  function expectBuildToThrow(
    name: string,
    cfg: SandboxDockerConfig,
    expectedMessage: RegExp,
  ): void {
    expect(
      () =>
        buildSandboxCreateArgs({
          name,
          cfg,
          scopeKey: "main",
          createdAtMs: 1700000000000,
        }),
      name,
    ).toThrow(expectedMessage);
  }

  function valuesForFlag(args: string[], flag: string): string[] {
    const values: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === flag) {
        const value = args[i + 1];
        if (value) {
          values.push(value);
        }
      }
    }
    return values;
  }

  function expectFlagValues(args: string[], flag: string, expectedValues: string[]): void {
    const values = valuesForFlag(args, flag);
    for (const value of expectedValues) {
      expect(values).toContain(value);
    }
  }

  it("includes hardening and resource flags", () => {
    const cfg: SandboxDockerConfig = {
      image: "openclaw-sandbox:bookworm-slim",
      containerPrefix: "openclaw-sbx-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: ["/tmp"],
      network: "none",
      user: "1000:1000",
      capDrop: ["ALL"],
      env: { LANG: "C.UTF-8" },
      pidsLimit: 256,
      memory: "512m",
      memorySwap: 1024,
      cpus: 1.5,
      ulimits: {
        nofile: { soft: 1024, hard: 2048 },
        nproc: 128,
        core: "0",
      },
      seccompProfile: "/tmp/seccomp.json",
      apparmorProfile: "openclaw-sandbox",
      dns: ["1.1.1.1"],
      extraHosts: ["internal.service:10.0.0.5"],
    };

    const args = buildSandboxCreateArgs({
      name: "openclaw-sbx-test",
      cfg,
      scopeKey: "main",
      createdAtMs: 1700000000000,
      labels: { "openclaw.sandboxBrowser": "1" },
    });

    expect(args[0]).toBe("create");
    expectFlagValues(args, "--name", ["openclaw-sbx-test"]);
    expectFlagValues(args, "--label", [
      "openclaw.sandbox=1",
      "openclaw.sessionKey=main",
      "openclaw.createdAtMs=1700000000000",
      "openclaw.sandboxBrowser=1",
    ]);
    expect(args).toContain("--read-only");
    expectFlagValues(args, "--tmpfs", ["/tmp"]);
    expectFlagValues(args, "--network", ["none"]);
    expectFlagValues(args, "--user", ["1000:1000"]);
    expectFlagValues(args, "--cap-drop", ["ALL"]);
    expectFlagValues(args, "--security-opt", [
      "no-new-privileges",
      "seccomp=/tmp/seccomp.json",
      "apparmor=openclaw-sandbox",
    ]);
    expectFlagValues(args, "--dns", ["1.1.1.1"]);
    expectFlagValues(args, "--add-host", ["internal.service:10.0.0.5"]);
    expectFlagValues(args, "--pids-limit", ["256"]);
    expectFlagValues(args, "--memory", ["512m"]);
    expectFlagValues(args, "--memory-swap", ["1024"]);
    expectFlagValues(args, "--cpus", ["1.5"]);
    expectFlagValues(args, "--env", ["LANG=C.UTF-8", `OPENCLAW_CLI=${OPENCLAW_CLI_ENV_VALUE}`]);
    expectFlagValues(args, "--ulimit", ["nofile=1024:2048", "nproc=128", "core=0"]);
  });

  it("preserves the OpenClaw exec marker when strict env sanitization is enabled", () => {
    const cfg = createSandboxConfig({
      env: {
        NODE_ENV: "test",
      },
    });

    const args = buildSandboxCreateArgs({
      name: "openclaw-sbx-marker",
      cfg,
      scopeKey: "main",
      createdAtMs: 1700000000000,
      envSanitizationOptions: {
        strictMode: true,
      },
    });

    expectFlagValues(args, "--env", ["NODE_ENV=test", `OPENCLAW_CLI=${OPENCLAW_CLI_ENV_VALUE}`]);
  });

  it("emits Docker GPU passthrough as a separate argument", () => {
    const cfg = createSandboxConfig({
      gpus: "device=GPU-123",
    });

    const args = buildSandboxCreateArgs({
      name: "openclaw-sbx-gpu",
      cfg,
      scopeKey: "main",
      createdAtMs: 1700000000000,
    });

    expectFlagValues(args, "--gpus", ["device=GPU-123"]);
  });

  it("emits -v flags for safe custom binds", () => {
    const cfg: SandboxDockerConfig = {
      image: "openclaw-sandbox:bookworm-slim",
      containerPrefix: "openclaw-sbx-",
      workdir: "/workspace",
      readOnlyRoot: false,
      tmpfs: [],
      network: "none",
      capDrop: [],
      binds: ["/home/user/source:/source:rw", "/var/data/myapp:/data:ro"],
    };

    const args = buildSandboxCreateArgs({
      name: "openclaw-sbx-binds",
      cfg,
      scopeKey: "main",
      createdAtMs: 1700000000000,
    });

    expect(args).toContain("-v");
    const vFlags: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-v") {
        const value = args[i + 1];
        if (value) {
          vFlags.push(value);
        }
      }
    }
    expect(vFlags).toContain("/home/user/source:/source:rw");
    expect(vFlags).toContain("/var/data/myapp:/data:ro");
  });

  it.each([
    {
      name: "dangerous Docker socket bind mounts",
      containerName: "openclaw-sbx-dangerous",
      cfg: createSandboxConfig({}, ["/var/run/docker.sock:/var/run/docker.sock"]),
      expected: /blocked path/,
    },
    {
      name: "dangerous parent bind mounts",
      containerName: "openclaw-sbx-dangerous-parent",
      cfg: createSandboxConfig({}, ["/run:/run"]),
      expected: /blocked path/,
    },
    {
      name: "network host mode",
      containerName: "openclaw-sbx-host",
      cfg: createSandboxConfig({ network: "host" }),
      expected: /network mode "host" is blocked/,
    },
    {
      name: "network container namespace join",
      containerName: "openclaw-sbx-container-network",
      cfg: createSandboxConfig({ network: "container:peer" }),
      expected: /network mode "container:peer" is blocked by default/,
    },
    {
      name: "seccomp unconfined",
      containerName: "openclaw-sbx-seccomp",
      cfg: createSandboxConfig({ seccompProfile: "unconfined" }),
      expected: /seccomp profile "unconfined" is blocked/,
    },
    {
      name: "apparmor unconfined",
      containerName: "openclaw-sbx-apparmor",
      cfg: createSandboxConfig({ apparmorProfile: "unconfined" }),
      expected: /apparmor profile "unconfined" is blocked/,
    },
  ])("throws on $name", ({ containerName, cfg, expected }) => {
    expectBuildToThrow(containerName, cfg, expected);
  });

  it("omits -v flags when binds is empty or undefined", () => {
    const cfg: SandboxDockerConfig = {
      image: "openclaw-sandbox:bookworm-slim",
      containerPrefix: "openclaw-sbx-",
      workdir: "/workspace",
      readOnlyRoot: false,
      tmpfs: [],
      network: "none",
      capDrop: [],
      binds: [],
    };

    const args = buildSandboxCreateArgs({
      name: "openclaw-sbx-no-binds",
      cfg,
      scopeKey: "main",
      createdAtMs: 1700000000000,
    });

    // Count -v flags that are NOT workspace mounts (workspace mounts are internal)
    const customVFlags: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-v") {
        const value = args[i + 1];
        if (value && !value.includes("/workspace")) {
          customVFlags.push(value);
        }
      }
    }
    expect(customVFlags).toHaveLength(0);
  });

  it("blocks bind sources outside runtime allowlist roots", () => {
    const cfg = createSandboxConfig({}, ["/opt/external:/data:rw"]);
    expect(() =>
      buildSandboxCreateArgs({
        name: "openclaw-sbx-outside-roots",
        cfg,
        scopeKey: "main",
        createdAtMs: 1700000000000,
        bindSourceRoots: ["/tmp/workspace", "/tmp/agent"],
      }),
    ).toThrow(/outside allowed roots/);
  });

  it("allows bind sources outside runtime allowlist with explicit override", () => {
    const cfg = createSandboxConfig({}, ["/opt/external:/data:rw"]);
    const args = buildSandboxCreateArgs({
      name: "openclaw-sbx-outside-roots-override",
      cfg,
      scopeKey: "main",
      createdAtMs: 1700000000000,
      bindSourceRoots: ["/tmp/workspace", "/tmp/agent"],
      allowSourcesOutsideAllowedRoots: true,
    });
    expectFlagValues(args, "-v", ["/opt/external:/data:rw"]);
  });

  it("blocks reserved /workspace target bind mounts by default", () => {
    const cfg = createSandboxConfig({}, ["/tmp/override:/workspace:rw"]);
    expectBuildToThrow("openclaw-sbx-reserved-target", cfg, /reserved container path/);
  });

  it("allows reserved /workspace target bind mounts with explicit dangerous override", () => {
    const cfg = createSandboxConfig({}, ["/tmp/override:/workspace:rw"]);
    const args = buildSandboxCreateArgs({
      name: "openclaw-sbx-reserved-target-override",
      cfg,
      scopeKey: "main",
      createdAtMs: 1700000000000,
      allowReservedContainerTargets: true,
    });
    expectFlagValues(args, "-v", ["/tmp/override:/workspace:rw"]);
  });

  it("allows container namespace join with explicit dangerous override", () => {
    const cfg = createSandboxConfig({
      network: "container:peer",
      dangerouslyAllowContainerNamespaceJoin: true,
    });
    const args = buildSandboxCreateArgs({
      name: "openclaw-sbx-container-network-override",
      cfg,
      scopeKey: "main",
      createdAtMs: 1700000000000,
    });
    expectFlagValues(args, "--network", ["container:peer"]);
  });
});
