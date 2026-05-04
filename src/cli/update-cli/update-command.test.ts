import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildGatewayInstallEntrypointCandidates as resolveGatewayInstallEntrypointCandidates,
  resolveGatewayInstallEntrypoint,
} from "../../daemon/gateway-entrypoint.js";
import {
  collectMissingPluginInstallPayloads,
  recoverInstalledLaunchAgentAfterUpdate,
  recoverLaunchAgentAndRecheckGatewayHealth,
  resolvePostInstallDoctorEnv,
  shouldPrepareUpdatedInstallRestart,
  resolveUpdatedGatewayRestartPort,
  shouldUseLegacyProcessRestartAfterUpdate,
} from "./update-command.js";

describe("resolveGatewayInstallEntrypointCandidates", () => {
  it("prefers index.js before legacy entry.js", () => {
    expect(resolveGatewayInstallEntrypointCandidates("/tmp/openclaw-root")).toEqual([
      path.join("/tmp/openclaw-root", "dist", "index.js"),
      path.join("/tmp/openclaw-root", "dist", "index.mjs"),
      path.join("/tmp/openclaw-root", "dist", "entry.js"),
      path.join("/tmp/openclaw-root", "dist", "entry.mjs"),
    ]);
  });
});

describe("resolveGatewayInstallEntrypoint", () => {
  it("prefers dist/index.js over dist/entry.js when both exist", async () => {
    const root = "/tmp/openclaw-root";
    const indexPath = path.join(root, "dist", "index.js");
    const entryPath = path.join(root, "dist", "entry.js");

    await expect(
      resolveGatewayInstallEntrypoint(
        root,
        async (candidate) => candidate === indexPath || candidate === entryPath,
      ),
    ).resolves.toBe(indexPath);
  });

  it("falls back to dist/entry.js when index.js is missing", async () => {
    const root = "/tmp/openclaw-root";
    const entryPath = path.join(root, "dist", "entry.js");

    await expect(
      resolveGatewayInstallEntrypoint(root, async (candidate) => candidate === entryPath),
    ).resolves.toBe(entryPath);
  });
});

describe("shouldPrepareUpdatedInstallRestart", () => {
  it("prepares package update restarts when the service is installed but stopped", () => {
    expect(
      shouldPrepareUpdatedInstallRestart({
        updateMode: "npm",
        serviceInstalled: true,
        serviceLoaded: false,
      }),
    ).toBe(true);
  });

  it("does not install a new service for package updates when no service exists", () => {
    expect(
      shouldPrepareUpdatedInstallRestart({
        updateMode: "npm",
        serviceInstalled: false,
        serviceLoaded: false,
      }),
    ).toBe(false);
  });

  it("keeps non-package updates tied to the loaded service state", () => {
    expect(
      shouldPrepareUpdatedInstallRestart({
        updateMode: "git",
        serviceInstalled: true,
        serviceLoaded: false,
      }),
    ).toBe(false);
    expect(
      shouldPrepareUpdatedInstallRestart({
        updateMode: "git",
        serviceInstalled: true,
        serviceLoaded: true,
      }),
    ).toBe(true);
  });
});

describe("resolveUpdatedGatewayRestartPort", () => {
  it("uses the managed service port ahead of the caller environment", () => {
    expect(
      resolveUpdatedGatewayRestartPort({
        config: { gateway: { port: 19000 } } as never,
        processEnv: { OPENCLAW_GATEWAY_PORT: "19001" },
        serviceEnv: { OPENCLAW_GATEWAY_PORT: "19002" },
      }),
    ).toBe(19002);
  });

  it("falls back to the post-update config when no service port is available", () => {
    expect(
      resolveUpdatedGatewayRestartPort({
        config: { gateway: { port: 19000 } } as never,
        processEnv: {},
        serviceEnv: {},
      }),
    ).toBe(19000);
  });
});

describe("resolvePostInstallDoctorEnv", () => {
  it("uses the managed service profile paths for post-install doctor", () => {
    const env = resolvePostInstallDoctorEnv({
      invocationCwd: "/srv/openclaw",
      baseEnv: {
        PATH: "/bin",
        OPENCLAW_STATE_DIR: "/wrong/state",
        OPENCLAW_CONFIG_PATH: "/wrong/openclaw.json",
        OPENCLAW_PROFILE: "wrong",
      },
      serviceEnv: {
        OPENCLAW_STATE_DIR: "daemon-state",
        OPENCLAW_CONFIG_PATH: "daemon-state/openclaw.json",
        OPENCLAW_PROFILE: "work",
      },
    });

    expect(env.PATH).toBe("/bin");
    expect(env.NODE_DISABLE_COMPILE_CACHE).toBe("1");
    expect(env.OPENCLAW_STATE_DIR).toBe(path.join("/srv/openclaw", "daemon-state"));
    expect(env.OPENCLAW_CONFIG_PATH).toBe(
      path.join("/srv/openclaw", "daemon-state", "openclaw.json"),
    );
    expect(env.OPENCLAW_PROFILE).toBe("work");
  });

  it("keeps the caller env when no managed service env is available", () => {
    const env = resolvePostInstallDoctorEnv({
      baseEnv: {
        PATH: "/bin",
        OPENCLAW_STATE_DIR: "/caller/state",
        OPENCLAW_PROFILE: "caller",
      },
    });

    expect(env.PATH).toBe("/bin");
    expect(env.NODE_DISABLE_COMPILE_CACHE).toBe("1");
    expect(env.OPENCLAW_STATE_DIR).toBe("/caller/state");
    expect(env.OPENCLAW_PROFILE).toBe("caller");
  });
});

describe("collectMissingPluginInstallPayloads", () => {
  it("reports tracked npm install records whose package payload is absent", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-plugin-payload-"));
    const presentDir = path.join(tmpDir, "state", "npm", "node_modules", "@openclaw", "present");
    const missingDir = path.join(tmpDir, "state", "npm", "node_modules", "@openclaw", "missing");
    const noPackageJsonDir = path.join(
      tmpDir,
      "state",
      "npm",
      "node_modules",
      "@openclaw",
      "no-package-json",
    );
    try {
      await fs.mkdir(presentDir, { recursive: true });
      await fs.writeFile(path.join(presentDir, "package.json"), '{"name":"@openclaw/present"}\n');
      await fs.mkdir(noPackageJsonDir, { recursive: true });

      await expect(
        collectMissingPluginInstallPayloads({
          env: { HOME: tmpDir } as NodeJS.ProcessEnv,
          records: {
            present: {
              source: "npm",
              spec: "@openclaw/present@beta",
              installPath: presentDir,
            },
            missing: {
              source: "npm",
              spec: "@openclaw/missing@beta",
              installPath: missingDir,
            },
            "no-package-json": {
              source: "npm",
              spec: "@openclaw/no-package-json@beta",
              installPath: noPackageJsonDir,
            },
            "missing-install-path": {
              source: "npm",
              spec: "@openclaw/missing-install-path@beta",
            },
            local: {
              source: "path",
              sourcePath: "/not/checked",
              installPath: "/not/checked",
            },
          },
        }),
      ).resolves.toEqual([
        {
          pluginId: "missing",
          installPath: missingDir,
          reason: "missing-package-dir",
        },
        {
          pluginId: "missing-install-path",
          reason: "missing-install-path",
        },
        {
          pluginId: "no-package-json",
          installPath: noPackageJsonDir,
          reason: "missing-package-json",
        },
      ]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("shouldUseLegacyProcessRestartAfterUpdate", () => {
  it("never restarts package updates through the pre-update process", () => {
    expect(shouldUseLegacyProcessRestartAfterUpdate({ updateMode: "npm" })).toBe(false);
    expect(shouldUseLegacyProcessRestartAfterUpdate({ updateMode: "pnpm" })).toBe(false);
    expect(shouldUseLegacyProcessRestartAfterUpdate({ updateMode: "bun" })).toBe(false);
  });

  it("keeps the in-process restart path for non-package updates", () => {
    expect(shouldUseLegacyProcessRestartAfterUpdate({ updateMode: "git" })).toBe(true);
    expect(shouldUseLegacyProcessRestartAfterUpdate({ updateMode: "unknown" })).toBe(true);
  });
});
describe("recoverInstalledLaunchAgentAfterUpdate", () => {
  it("re-bootstraps an installed-but-not-loaded macOS LaunchAgent after update", async () => {
    const service = {} as never;
    const serviceEnv = { OPENCLAW_PROFILE: "stomme" } as NodeJS.ProcessEnv;
    const recoveredEnv = { ...serviceEnv, OPENCLAW_PORT: "18790" } as NodeJS.ProcessEnv;
    const readState = vi.fn(async () => ({
      installed: true,
      loaded: false,
      running: false,
      env: recoveredEnv,
      command: null,
      runtime: { status: "unknown", missingSupervision: true },
    }));
    const recover = vi.fn(async () => ({
      result: "restarted" as const,
      loaded: true as const,
      message: "Gateway LaunchAgent was installed but not loaded; re-bootstrapped launchd service.",
    }));

    await expect(
      recoverInstalledLaunchAgentAfterUpdate({
        service,
        env: serviceEnv,
        deps: {
          platform: "darwin",
          readState: readState as never,
          recover: recover as never,
        },
      }),
    ).resolves.toEqual({
      attempted: true,
      recovered: true,
      message: "Gateway LaunchAgent was installed but not loaded; re-bootstrapped launchd service.",
    });

    expect(readState).toHaveBeenCalledWith(service, { env: serviceEnv });
    expect(recover).toHaveBeenCalledWith({ result: "restarted", env: recoveredEnv });
  });

  it("does not touch non-macOS service managers", async () => {
    const readState = vi.fn();
    const recover = vi.fn();

    await expect(
      recoverInstalledLaunchAgentAfterUpdate({
        service: {} as never,
        deps: {
          platform: "linux",
          readState: readState as never,
          recover: recover as never,
        },
      }),
    ).resolves.toEqual({ attempted: false, recovered: false });

    expect(readState).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  });

  it("does not recover a loaded LaunchAgent", async () => {
    const readState = vi.fn(async () => ({
      installed: true,
      loaded: true,
      running: true,
      env: { OPENCLAW_PROFILE: "stomme" } as NodeJS.ProcessEnv,
      command: null,
      runtime: { status: "running" },
    }));
    const recover = vi.fn();

    await expect(
      recoverInstalledLaunchAgentAfterUpdate({
        service: {} as never,
        deps: {
          platform: "darwin",
          readState: readState as never,
          recover: recover as never,
        },
      }),
    ).resolves.toEqual({ attempted: false, recovered: false });

    expect(recover).not.toHaveBeenCalled();
  });

  it("returns an explicit failed recovery state when bootstrap repair fails", async () => {
    const readState = vi.fn(async () => ({
      installed: true,
      loaded: false,
      running: false,
      env: { OPENCLAW_PROFILE: "stomme" } as NodeJS.ProcessEnv,
      command: null,
      runtime: { status: "unknown", missingSupervision: true },
    }));
    const recover = vi.fn(async () => null);

    await expect(
      recoverInstalledLaunchAgentAfterUpdate({
        service: {} as never,
        deps: {
          platform: "darwin",
          readState: readState as never,
          recover: recover as never,
        },
      }),
    ).resolves.toEqual({
      attempted: true,
      recovered: false,
      detail:
        "LaunchAgent was installed but not loaded; automatic bootstrap/kickstart recovery failed.",
    });
  });
});

describe("recoverLaunchAgentAndRecheckGatewayHealth", () => {
  it("does not report recovered update health until the gateway passes the post-recovery wait", async () => {
    const service = {} as never;
    const unhealthy = {
      runtime: { status: "stopped" },
      portUsage: { port: 18790, status: "free", listeners: [], hints: [] },
      healthy: false,
      staleGatewayPids: [],
      waitOutcome: "stopped-free",
    } as never;
    const healthy = {
      runtime: { status: "running", pid: 4242 },
      portUsage: { port: 18790, status: "busy", listeners: [{ pid: 4242 }], hints: [] },
      healthy: true,
      staleGatewayPids: [],
      gatewayVersion: "2026.5.3",
      waitOutcome: "healthy",
    } as never;
    const recoverLaunchAgent = vi.fn(async () => ({
      attempted: true as const,
      recovered: true as const,
      message: "Gateway LaunchAgent was installed but not loaded; re-bootstrapped launchd service.",
    }));
    const waitForHealthy = vi.fn(async () => healthy);

    await expect(
      recoverLaunchAgentAndRecheckGatewayHealth({
        health: unhealthy,
        service,
        port: 18790,
        expectedVersion: "2026.5.3",
        env: { OPENCLAW_PROFILE: "stomme", OPENCLAW_PORT: "18790" },
        deps: { recoverLaunchAgent, waitForHealthy },
      }),
    ).resolves.toEqual({
      health: healthy,
      launchAgentRecovery: {
        attempted: true,
        recovered: true,
        message:
          "Gateway LaunchAgent was installed but not loaded; re-bootstrapped launchd service.",
      },
    });

    expect(waitForHealthy).toHaveBeenCalledWith({
      service,
      port: 18790,
      expectedVersion: "2026.5.3",
      env: { OPENCLAW_PROFILE: "stomme", OPENCLAW_PORT: "18790" },
    });
  });

  it("keeps the update unhealthy when LaunchAgent repair succeeds but health does not recover", async () => {
    const service = {} as never;
    const unhealthySnapshot = {
      runtime: { status: "stopped" },
      portUsage: { port: 18790, status: "free", listeners: [], hints: [] },
      healthy: false,
      staleGatewayPids: [],
      waitOutcome: "stopped-free",
    };
    const unhealthy = unhealthySnapshot as never;
    const stillUnhealthy = {
      ...unhealthySnapshot,
      waitOutcome: "timeout",
    } as never;
    const recoverLaunchAgent = vi.fn(async () => ({
      attempted: true as const,
      recovered: true as const,
      message: "Gateway LaunchAgent was installed but not loaded; re-bootstrapped launchd service.",
    }));
    const waitForHealthy = vi.fn(async () => stillUnhealthy);

    await expect(
      recoverLaunchAgentAndRecheckGatewayHealth({
        health: unhealthy,
        service,
        port: 18790,
        expectedVersion: "2026.5.3",
        deps: { recoverLaunchAgent, waitForHealthy },
      }),
    ).resolves.toMatchObject({
      health: { healthy: false, waitOutcome: "timeout" },
      launchAgentRecovery: { attempted: true, recovered: true },
    });
  });
});
