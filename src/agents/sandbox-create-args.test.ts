import { describe, expect, it } from "vitest";

import { buildSandboxCreateArgs, type SandboxDockerConfig } from "./sandbox.js";

describe("buildSandboxCreateArgs", () => {
  it("includes hardening and resource flags", () => {
    const cfg: SandboxDockerConfig = {
      image: "moltbot-sandbox:bookworm-slim",
      containerPrefix: "moltbot-sbx-",
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
      apparmorProfile: "moltbot-sandbox",
      dns: ["1.1.1.1"],
      extraHosts: ["internal.service:10.0.0.5"],
    };

    const args = buildSandboxCreateArgs({
      name: "moltbot-sbx-test",
      cfg,
      scopeKey: "main",
      createdAtMs: 1700000000000,
      labels: { "moltbot.sandboxBrowser": "1" },
    });

    expect(args).toEqual(
      expect.arrayContaining([
        "create",
        "--name",
        "moltbot-sbx-test",
        "--label",
        "moltbot.sandbox=1",
        "--label",
        "moltbot.sessionKey=main",
        "--label",
        "moltbot.createdAtMs=1700000000000",
        "--label",
        "moltbot.sandboxBrowser=1",
        "--read-only",
        "--tmpfs",
        "/tmp",
        "--network",
        "none",
        "--user",
        "1000:1000",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--security-opt",
        "seccomp=/tmp/seccomp.json",
        "--security-opt",
        "apparmor=moltbot-sandbox",
        "--dns",
        "1.1.1.1",
        "--add-host",
        "internal.service:10.0.0.5",
        "--pids-limit",
        "256",
        "--memory",
        "512m",
        "--memory-swap",
        "1024",
        "--cpus",
        "1.5",
      ]),
    );

    const ulimitValues: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === "--ulimit") {
        const value = args[i + 1];
        if (value) ulimitValues.push(value);
      }
    }
    expect(ulimitValues).toEqual(
      expect.arrayContaining(["nofile=1024:2048", "nproc=128", "core=0"]),
    );
  });

  it("emits -v flags for custom binds", () => {
    const cfg: SandboxDockerConfig = {
      image: "moltbot-sandbox:bookworm-slim",
      containerPrefix: "moltbot-sbx-",
      workdir: "/workspace",
      readOnlyRoot: false,
      tmpfs: [],
      network: "none",
      capDrop: [],
      binds: ["/home/user/source:/source:rw", "/var/run/docker.sock:/var/run/docker.sock"],
    };

    const args = buildSandboxCreateArgs({
      name: "moltbot-sbx-binds",
      cfg,
      scopeKey: "main",
      createdAtMs: 1700000000000,
    });

    expect(args).toContain("-v");
    const vFlags: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-v") {
        const value = args[i + 1];
        if (value) vFlags.push(value);
      }
    }
    expect(vFlags).toContain("/home/user/source:/source:rw");
    expect(vFlags).toContain("/var/run/docker.sock:/var/run/docker.sock");
  });

  it("omits -v flags when binds is empty or undefined", () => {
    const cfg: SandboxDockerConfig = {
      image: "moltbot-sandbox:bookworm-slim",
      containerPrefix: "moltbot-sbx-",
      workdir: "/workspace",
      readOnlyRoot: false,
      tmpfs: [],
      network: "none",
      capDrop: [],
      binds: [],
    };

    const args = buildSandboxCreateArgs({
      name: "moltbot-sbx-no-binds",
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
});
