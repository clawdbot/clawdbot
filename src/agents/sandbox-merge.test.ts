import { describe, expect, it } from "vitest";

describe("sandbox config merges", () => {
  it("resolves sandbox scope deterministically", { timeout: 60_000 }, async () => {
    const { resolveSandboxScope } = await import("./sandbox.js");

    expect(resolveSandboxScope({})).toBe("agent");
    expect(resolveSandboxScope({ perSession: true })).toBe("session");
    expect(resolveSandboxScope({ perSession: false })).toBe("shared");
    expect(resolveSandboxScope({ perSession: true, scope: "agent" })).toBe("agent");
  });

  it("merges sandbox docker env and ulimits (agent wins)", async () => {
    const { resolveSandboxDockerConfig } = await import("./sandbox.js");

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

  it("merges sandbox docker binds (global + agent combined)", async () => {
    const { resolveSandboxDockerConfig } = await import("./sandbox.js");

    const resolved = resolveSandboxDockerConfig({
      scope: "agent",
      globalDocker: {
        binds: ["/var/run/docker.sock:/var/run/docker.sock"],
      },
      agentDocker: {
        binds: ["/home/user/source:/source:rw"],
      },
    });

    expect(resolved.binds).toEqual([
      "/var/run/docker.sock:/var/run/docker.sock",
      "/home/user/source:/source:rw",
    ]);
  });

  it("returns undefined binds when neither global nor agent has binds", async () => {
    const { resolveSandboxDockerConfig } = await import("./sandbox.js");

    const resolved = resolveSandboxDockerConfig({
      scope: "agent",
      globalDocker: {},
      agentDocker: {},
    });

    expect(resolved.binds).toBeUndefined();
  });

  it("ignores agent binds under shared scope", async () => {
    const { resolveSandboxDockerConfig } = await import("./sandbox.js");

    const resolved = resolveSandboxDockerConfig({
      scope: "shared",
      globalDocker: {
        binds: ["/var/run/docker.sock:/var/run/docker.sock"],
      },
      agentDocker: {
        binds: ["/home/user/source:/source:rw"],
      },
    });

    expect(resolved.binds).toEqual(["/var/run/docker.sock:/var/run/docker.sock"]);
  });

  it("ignores agent docker overrides under shared scope", async () => {
    const { resolveSandboxDockerConfig } = await import("./sandbox.js");

    const resolved = resolveSandboxDockerConfig({
      scope: "shared",
      globalDocker: { image: "global" },
      agentDocker: { image: "agent" },
    });

    expect(resolved.image).toBe("global");
  });

  it("applies per-agent browser and prune overrides (ignored under shared scope)", async () => {
    const { resolveSandboxBrowserConfig, resolveSandboxPruneConfig } = await import("./sandbox.js");

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
});
