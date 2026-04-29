import { describe, expect, it } from "vitest";
import {
  resolveSandboxBrowserConfig,
  resolveSandboxConfigForAgent,
  resolveSandboxDockerConfig,
  resolveSandboxPruneConfig,
  resolveSandboxScope,
  resolveSandboxSshConfig,
} from "./sandbox/config.js";

describe("sandbox config merges", () => {
  it("resolves sandbox scope deterministically", () => {
    expect(resolveSandboxScope({})).toBe("agent");
    expect(resolveSandboxScope({ perSession: true })).toBe("session");
    expect(resolveSandboxScope({ perSession: false })).toBe("shared");
    expect(resolveSandboxScope({ perSession: true, scope: "agent" })).toBe("agent");
  });

  it("merges sandbox docker env and ulimits (agent wins)", () => {
    const resolved = resolveSandboxDockerConfig({
      scope: "agent",
      globalDocker: {
        env: { LANG: "C.UTF-8", FOO: "1" },
        ulimits: { nofile: { soft: 10, hard: 20 } },
      },
      agentDocker: {
        env: { FOO: "2", BAR: "3" },
        ulimits: { nproc: 256 },
      },
    });

    expect(resolved.env).toEqual({ LANG: "C.UTF-8", FOO: "2", BAR: "3" });
    expect(resolved.ulimits).toEqual({
      nofile: { soft: 10, hard: 20 },
      nproc: 256,
    });
  });

  it("resolves sandbox docker GPU passthrough with agent precedence", () => {
    const inherited = resolveSandboxDockerConfig({
      scope: "agent",
      globalDocker: { gpus: "all" },
      agentDocker: {},
    });
    expect(inherited.gpus).toBe("all");

    const overridden = resolveSandboxDockerConfig({
      scope: "agent",
      globalDocker: { gpus: "all" },
      agentDocker: { gpus: "device=GPU-123" },
    });
    expect(overridden.gpus).toBe("device=GPU-123");

    const sharedScope = resolveSandboxDockerConfig({
      scope: "shared",
      globalDocker: { gpus: "all" },
      agentDocker: { gpus: "device=GPU-123" },
    });
    expect(sharedScope.gpus).toBe("all");
  });

  it("resolves docker binds and shared-scope override behavior", () => {
    for (const scenario of [
      {
        name: "merges sandbox docker binds (global + agent combined)",
        input: {
          scope: "agent" as const,
          globalDocker: {
            binds: ["/var/run/docker.sock:/var/run/docker.sock"],
          },
          agentDocker: {
            binds: ["/home/user/source:/source:rw"],
          },
        },
        assert: (resolved: ReturnType<typeof resolveSandboxDockerConfig>) => {
          expect(resolved.binds).toEqual([
            "/var/run/docker.sock:/var/run/docker.sock",
            "/home/user/source:/source:rw",
          ]);
        },
      },
      {
        name: "returns undefined binds when neither global nor agent has binds",
        input: {
          scope: "agent" as const,
          globalDocker: {},
          agentDocker: {},
        },
        assert: (resolved: ReturnType<typeof resolveSandboxDockerConfig>) => {
          expect(resolved.binds).toBeUndefined();
        },
      },
      {
        name: "ignores agent binds under shared scope",
        input: {
          scope: "shared" as const,
          globalDocker: {
            binds: ["/var/run/docker.sock:/var/run/docker.sock"],
          },
          agentDocker: {
            binds: ["/home/user/source:/source:rw"],
          },
        },
        assert: (resolved: ReturnType<typeof resolveSandboxDockerConfig>) => {
          expect(resolved.binds).toEqual(["/var/run/docker.sock:/var/run/docker.sock"]);
        },
      },
      {
        name: "ignores agent docker overrides under shared scope",
        input: {
          scope: "shared" as const,
          globalDocker: { image: "global" },
          agentDocker: { image: "agent" },
        },
        assert: (resolved: ReturnType<typeof resolveSandboxDockerConfig>) => {
          expect(resolved.image).toBe("global");
        },
      },
    ]) {
      const resolved = resolveSandboxDockerConfig(scenario.input);
      scenario.assert(resolved);
    }
  });

  it("applies per-agent browser and prune overrides (ignored under shared scope)", () => {
    const browser = resolveSandboxBrowserConfig({
      scope: "agent",
      globalBrowser: { enabled: false, headless: false, enableNoVnc: true },
      agentBrowser: { enabled: true, headless: true, enableNoVnc: false },
    });
    expect(browser.enabled).toBe(true);
    expect(browser.headless).toBe(true);
    expect(browser.enableNoVnc).toBe(false);

    const prune = resolveSandboxPruneConfig({
      scope: "agent",
      globalPrune: { idleHours: 24, maxAgeDays: 7 },
      agentPrune: { idleHours: 0, maxAgeDays: 1 },
    });
    expect(prune).toEqual({ idleHours: 0, maxAgeDays: 1 });

    const browserShared = resolveSandboxBrowserConfig({
      scope: "shared",
      globalBrowser: { enabled: false },
      agentBrowser: { enabled: true },
    });
    expect(browserShared.enabled).toBe(false);

    const pruneShared = resolveSandboxPruneConfig({
      scope: "shared",
      globalPrune: { idleHours: 24, maxAgeDays: 7 },
      agentPrune: { idleHours: 0, maxAgeDays: 1 },
    });
    expect(pruneShared).toEqual({ idleHours: 24, maxAgeDays: 7 });
  });

  it("merges sandbox ssh settings and ignores agent overrides under shared scope", () => {
    const ssh = resolveSandboxSshConfig({
      scope: "agent",
      globalSsh: {
        target: "global@example.com:22",
        command: "ssh",
        identityFile: "~/.ssh/global",
        strictHostKeyChecking: true,
      },
      agentSsh: {
        target: "agent@example.com:2222",
        certificateFile: "~/.ssh/agent-cert.pub",
        strictHostKeyChecking: false,
      },
    });
    expect(ssh).toMatchObject({
      target: "agent@example.com:2222",
      command: "ssh",
      identityFile: "~/.ssh/global",
      certificateFile: "~/.ssh/agent-cert.pub",
      strictHostKeyChecking: false,
    });

    const sshShared = resolveSandboxSshConfig({
      scope: "shared",
      globalSsh: {
        target: "global@example.com:22",
      },
      agentSsh: {
        target: "agent@example.com:2222",
      },
    });
    expect(sshShared.target).toBe("global@example.com:22");
  });

  it("defaults sandbox backend to docker", () => {
    expect(resolveSandboxConfigForAgent().backend).toBe("docker");
  });
});
