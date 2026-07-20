// Browser tests cover profiles service plugin behavior.
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveOpenClawUserDataDir } from "./chrome.js";
import type { BrowserRouteContext, BrowserServerState } from "./server-context.js";
import {
  enqueueProfileStart,
  getProfileLifecycle,
  getOrCreateProfileRuntime,
  registerProfileHandle,
} from "./server-context.lifecycle.js";
import { movePathToTrash } from "./trash.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const configMocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn<() => OpenClawConfig>(),
  getRuntimeConfigSourceSnapshot: vi.fn<() => OpenClawConfig | null>(() => null),
  writeConfigFile: vi.fn<(cfg: OpenClawConfig) => Promise<void>>(async (_cfg) => {}),
  mutateConfigFile: vi.fn(
    async (params: {
      mutate: (
        draft: OpenClawConfig,
        context: {
          snapshot: {
            path: string;
            runtimeConfig: OpenClawConfig;
            sourceConfig: OpenClawConfig;
          };
        },
      ) => unknown;
    }) => {
      const currentConfig = structuredClone(configMocks.getRuntimeConfig());
      const draft = structuredClone(currentConfig);
      const result = await params.mutate(draft, {
        snapshot: {
          path: "/tmp/openclaw.json",
          runtimeConfig: currentConfig,
          sourceConfig: currentConfig,
        },
      });
      await configMocks.writeConfigFile(draft);
      return {
        path: "/tmp/openclaw.json",
        previousHash: "test-hash",
        persistedHash: "test-hash",
        snapshot: { path: "/tmp/openclaw.json" },
        nextConfig: draft,
        result,
        attempts: 1,
        afterWrite: { mode: "auto" },
        followUp: { action: "none" },
      };
    },
  ),
}));
const writeConfigFile = configMocks.writeConfigFile;
const lifecycleMocks = vi.hoisted(() => ({
  closeChromeMcpSession: vi.fn(async () => false),
  stopOpenClawChrome: vi.fn(async () => {}),
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    replaceConfigFile: vi.fn(async ({ nextConfig }: { nextConfig: OpenClawConfig }) => {
      await configMocks.writeConfigFile(nextConfig);
    }),
    mutateConfigFile: configMocks.mutateConfigFile,
    getRuntimeConfig: configMocks.getRuntimeConfig,
    getRuntimeConfigSourceSnapshot: configMocks.getRuntimeConfigSourceSnapshot,
  };
});

vi.mock("./trash.js", () => ({
  movePathToTrash: vi.fn(async (targetPath: string) => targetPath),
}));

vi.mock("./chrome-mcp.runtime.js", () => ({
  getChromeMcpModule: async () => ({
    closeChromeMcpSession: lifecycleMocks.closeChromeMcpSession,
  }),
}));

vi.mock("./pw-ai-module.js", () => ({
  getLoadedPwAiModule: () => null,
  getPwAiModule: async () => null,
}));

vi.mock("./chrome.js", () => ({
  resolveOpenClawUserDataDir: vi.fn(() => "/tmp/openclaw-test/openclaw/user-data"),
  stopOpenClawChrome: lifecycleMocks.stopOpenClawChrome,
}));

const [{ resolveBrowserConfig, resolveProfile }, { createBrowserProfilesService }] =
  await Promise.all([import("./config.js"), import("./profiles-service.js")]);
const { deleteBrowserProfileConfig, setDefaultBrowserProfile } =
  await import("./config-mutations.js");

function createCtx(resolved: BrowserServerState["resolved"]) {
  const state: BrowserServerState = {
    server: null as unknown as BrowserServerState["server"],
    port: 0,
    resolved,
    profiles: new Map(),
  };

  const ctx = {
    state: () => state,
    listProfiles: vi.fn(async () => []),
    forProfile: vi.fn(() => ({
      stopRunningBrowser: vi.fn(async () => ({ stopped: true })),
    })),
  } as unknown as BrowserRouteContext;

  return { state, ctx };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function createWorkProfileWithConfig(params: {
  resolved: BrowserServerState["resolved"];
  browserConfig: Record<string, unknown>;
}) {
  const { ctx, state } = createCtx(params.resolved);
  vi.mocked(getRuntimeConfig).mockReturnValue({ browser: params.browserConfig });
  const service = createBrowserProfilesService(ctx);
  const result = await service.createProfile({ name: "work" });
  return { result, state };
}

function writtenBrowserConfig(): Record<string, unknown> {
  const [call] = writeConfigFile.mock.calls;
  if (!call) {
    throw new Error("Expected written browser config call");
  }
  const [cfg] = call as [{ browser?: Record<string, unknown> }];
  if (!cfg?.browser) {
    throw new Error("Expected written browser config");
  }
  return cfg.browser;
}

describe("BrowserProfilesService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMocks.getRuntimeConfigSourceSnapshot.mockReset().mockReturnValue(null);
    configMocks.writeConfigFile.mockReset().mockResolvedValue(undefined);
    lifecycleMocks.closeChromeMcpSession.mockReset().mockResolvedValue(false);
    lifecycleMocks.stopOpenClawChrome.mockReset().mockResolvedValue(undefined);
    vi.mocked(resolveOpenClawUserDataDir)
      .mockReset()
      .mockReturnValue("/tmp/openclaw-test/openclaw/user-data");
    vi.mocked(movePathToTrash)
      .mockReset()
      .mockImplementation(async (targetPath) => targetPath);
  });

  it("allocates next local port for new profiles", async () => {
    const { result, state } = await createWorkProfileWithConfig({
      resolved: resolveBrowserConfig({}),
      browserConfig: { profiles: {} },
    });

    expect(result.cdpPort).toBe(18801);
    expect(result.isRemote).toBe(false);
    expect(state.resolved.profiles.work?.cdpPort).toBe(18801);
    expect(writeConfigFile).toHaveBeenCalled();
  });

  it("round-trips prototype-like profile names as own entries", async () => {
    for (const profileName of ["constructor", "prototype"] as const) {
      writeConfigFile.mockClear();
      const resolved = resolveBrowserConfig({});
      const { ctx, state } = createCtx(resolved);
      vi.mocked(getRuntimeConfig).mockReturnValue({ browser: { profiles: {} } });

      const service = createBrowserProfilesService(ctx);
      const result = await service.createProfile({ name: profileName });

      expect(result.profile).toBe(profileName);
      expect(Object.hasOwn(state.resolved.profiles, profileName)).toBe(true);
      const createdProfiles = writtenBrowserConfig().profiles as Record<
        string,
        { cdpPort?: number; color: string }
      >;
      expect(Object.hasOwn(createdProfiles, profileName)).toBe(true);

      writeConfigFile.mockClear();
      const createdProfile = expectDefined(createdProfiles[profileName], "created browser profile");
      vi.mocked(getRuntimeConfig).mockReturnValue({
        browser: {
          defaultProfile: "openclaw",
          profiles: { [profileName]: createdProfile },
        },
      });
      await service.deleteProfile(profileName);

      const deletedProfiles = writtenBrowserConfig().profiles as Record<
        string,
        { cdpPort?: number; color: string }
      >;
      expect(Object.hasOwn(deletedProfiles, profileName)).toBe(false);
      expect(Object.hasOwn(state.resolved.profiles, profileName)).toBe(false);
      expect(resolveProfile(resolveBrowserConfig({ profiles: deletedProfiles }), profileName)).toBe(
        null,
      );
    }
  });

  it("persists an existing managed profile as the browser default", async () => {
    vi.mocked(getRuntimeConfig).mockReturnValue({
      browser: {
        profiles: {
          imported: { cdpPort: 18801, color: "#0066CC" },
        },
      },
    });

    await setDefaultBrowserProfile("imported");

    expect(writtenBrowserConfig().defaultProfile).toBe("imported");
  });

  it("rechecks default-profile ownership inside the delete config mutation", async () => {
    vi.mocked(getRuntimeConfig).mockReturnValue({
      browser: {
        defaultProfile: "work",
        profiles: { work: { cdpPort: 18801, color: "#0066CC" } },
      },
    });

    await expect(
      deleteBrowserProfileConfig({
        name: "work",
        expected: { cdpPort: 18801, color: "#0066CC" },
      }),
    ).rejects.toThrow('cannot delete the default profile "work"');
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("falls back to derived CDP range when resolved CDP range is missing", async () => {
    const base = resolveBrowserConfig({});
    const baseWithoutRange = { ...base } as {
      [key: string]: unknown;
      cdpPortRangeStart?: unknown;
      cdpPortRangeEnd?: unknown;
    };
    delete baseWithoutRange.cdpPortRangeStart;
    delete baseWithoutRange.cdpPortRangeEnd;
    const resolved = {
      ...baseWithoutRange,
      controlPort: 30000,
    } as BrowserServerState["resolved"];
    const { result, state } = await createWorkProfileWithConfig({
      resolved,
      browserConfig: { profiles: {} },
    });

    expect(result.cdpPort).toBe(30009);
    expect(state.resolved.profiles.work?.cdpPort).toBe(30009);
    expect(writeConfigFile).toHaveBeenCalled();
  });

  it("allocates local ports from the rebased config snapshot", async () => {
    const resolved = resolveBrowserConfig({});
    const { ctx, state } = createCtx(resolved);
    vi.mocked(getRuntimeConfig)
      .mockReturnValueOnce({ browser: { profiles: {} } })
      .mockReturnValue({
        browser: {
          profiles: {
            other: { cdpPort: 18801, color: "#0066CC" },
          },
        },
      });

    const service = createBrowserProfilesService(ctx);
    const result = await service.createProfile({ name: "work" });

    expect(result.cdpPort).toBe(18802);
    expect(state.resolved.profiles.work?.cdpPort).toBe(18802);
    const profiles = writtenBrowserConfig().profiles as Record<string, { cdpPort?: number }>;
    expect(profiles.other?.cdpPort).toBe(18801);
    expect(profiles.work?.cdpPort).toBe(18802);
  });

  it("allocates local ports from the rebased CDP range end", async () => {
    const resolved = resolveBrowserConfig({});
    const { ctx, state } = createCtx(resolved);
    vi.mocked(getRuntimeConfig)
      .mockReturnValueOnce({
        browser: {
          profiles: {},
        },
      } as OpenClawConfig)
      .mockReturnValue({
        browser: {
          cdpPortRangeEnd: 18801,
          profiles: {},
        },
      } as unknown as OpenClawConfig);

    const service = createBrowserProfilesService(ctx);
    const result = await service.createProfile({ name: "work" });

    expect(result.cdpPort).toBe(18801);
    expect(state.resolved.profiles.work?.cdpPort).toBe(18801);
    const profiles = writtenBrowserConfig().profiles as Record<string, { cdpPort?: number }>;
    expect(profiles.work?.cdpPort).toBe(18801);
  });

  it("accepts per-profile cdpUrl for remote Chrome", async () => {
    const resolved = resolveBrowserConfig({
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    });
    const { ctx } = createCtx(resolved);

    vi.mocked(getRuntimeConfig).mockReturnValue({ browser: { profiles: {} } });

    const service = createBrowserProfilesService(ctx);
    const result = await service.createProfile({
      name: "remote",
      cdpUrl: "http://10.0.0.42:9222",
    });

    expect(result.cdpUrl).toBe("http://10.0.0.42:9222");
    expect(result.cdpPort).toBe(9222);
    expect(result.isRemote).toBe(true);
    const profiles = writtenBrowserConfig().profiles as Record<string, { cdpUrl?: string }>;
    expect(profiles.remote?.cdpUrl).toBe("http://10.0.0.42:9222");
  });

  it("redacts CDP credentials from create responses while preserving profile auth", async () => {
    const resolved = resolveBrowserConfig({
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    });
    const { ctx } = createCtx(resolved);
    const cdpUrl = "http://browser-user:browser-password@127.0.0.1:9222/?token=browser-token";

    vi.mocked(getRuntimeConfig).mockReturnValue({ browser: { profiles: {} } });

    const service = createBrowserProfilesService(ctx);
    const result = await service.createProfile({ name: "remote", cdpUrl });

    expect(result.cdpUrl).toBe("http://127.0.0.1:9222/?token=***");
    expect(result.cdpUrl).not.toContain("browser-user");
    expect(result.cdpUrl).not.toContain("browser-password");
    expect(result.cdpUrl).not.toContain("browser-token");
    const profiles = writtenBrowserConfig().profiles as Record<string, { cdpUrl?: string }>;
    expect(profiles.remote?.cdpUrl).toBe(cdpUrl);
  });

  it("rejects private-network cdpUrl when strict SSRF mode is enabled", async () => {
    const resolved = resolveBrowserConfig({
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
    });
    const { ctx } = createCtx(resolved);

    vi.mocked(getRuntimeConfig).mockReturnValue({
      browser: {
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
        profiles: {},
      },
    });

    const service = createBrowserProfilesService(ctx);

    await expect(
      service.createProfile({
        name: "remote",
        cdpUrl: "http://10.0.0.42:9222",
      }),
    ).rejects.toThrow(/private\/internal\/special-use ip address/i);
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("creates existing-session profiles as attach-only local entries", async () => {
    const resolved = resolveBrowserConfig({});
    const { ctx, state } = createCtx(resolved);
    vi.mocked(getRuntimeConfig).mockReturnValue({ browser: { profiles: {} } });

    const service = createBrowserProfilesService(ctx);
    const result = await service.createProfile({
      name: "chrome-live",
      driver: "existing-session",
    });

    expect(result.transport).toBe("chrome-mcp");
    expect(result.cdpPort).toBeNull();
    expect(result.cdpUrl).toBeNull();
    expect(result.userDataDir).toBeNull();
    expect(result.isRemote).toBe(false);
    const resolvedProfile = state.resolved.profiles["chrome-live"];
    expect(resolvedProfile?.driver).toBe("existing-session");
    expect(resolvedProfile?.attachOnly).toBe(true);
    expect(typeof resolvedProfile?.color).toBe("string");
    const profiles = writtenBrowserConfig().profiles as Record<
      string,
      { attachOnly?: boolean; driver?: string }
    >;
    expect(profiles["chrome-live"]?.driver).toBe("existing-session");
    expect(profiles["chrome-live"]?.attachOnly).toBe(true);
  });

  it("accepts driver=existing-session with cdpUrl", async () => {
    const resolved = resolveBrowserConfig({});
    const { ctx, state } = createCtx(resolved);
    vi.mocked(getRuntimeConfig).mockReturnValue({ browser: { profiles: {} } });

    const service = createBrowserProfilesService(ctx);
    const result = await service.createProfile({
      name: "chrome-live",
      driver: "existing-session",
      cdpUrl: "http://127.0.0.1:9222/",
    });

    expect(result.transport).toBe("chrome-mcp");
    expect(result.cdpPort).toBeNull();
    expect(result.cdpUrl).toBe("http://127.0.0.1:9222");
    expect(result.userDataDir).toBeNull();
    const resolvedProfile = state.resolved.profiles["chrome-live"];
    expect(resolvedProfile?.driver).toBe("existing-session");
    expect(resolvedProfile?.attachOnly).toBe(true);
    expect(resolvedProfile?.cdpUrl).toBe("http://127.0.0.1:9222");
    const profiles = writtenBrowserConfig().profiles as Record<
      string,
      { cdpUrl?: string; driver?: string }
    >;
    expect(profiles["chrome-live"]?.driver).toBe("existing-session");
    expect(profiles["chrome-live"]?.cdpUrl).toBe("http://127.0.0.1:9222");
  });

  it("rejects private-network cdpUrl for existing-session when strict SSRF mode is enabled", async () => {
    const resolved = resolveBrowserConfig({
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
    });
    const { ctx } = createCtx(resolved);

    vi.mocked(getRuntimeConfig).mockReturnValue({
      browser: {
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
        profiles: {},
      },
    });

    const service = createBrowserProfilesService(ctx);

    await expect(
      service.createProfile({
        name: "chrome-live",
        driver: "existing-session",
        cdpUrl: "http://10.0.0.42:9222",
      }),
    ).rejects.toThrow(/private\/internal\/special-use ip address/i);
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("creates existing-session profiles with an explicit userDataDir", async () => {
    const resolved = resolveBrowserConfig({});
    const { ctx, state } = createCtx(resolved);
    vi.mocked(getRuntimeConfig).mockReturnValue({ browser: { profiles: {} } });

    const tempDir = tempDirs.make("openclaw-profile-");
    const userDataDir = path.join(tempDir, "BraveSoftware", "Brave-Browser");
    fs.mkdirSync(userDataDir, { recursive: true });

    const service = createBrowserProfilesService(ctx);
    const result = await service.createProfile({
      name: "brave-live",
      driver: "existing-session",
      userDataDir,
    });

    expect(result.transport).toBe("chrome-mcp");
    expect(result.userDataDir).toBe(userDataDir);
    const resolvedProfile = state.resolved.profiles["brave-live"];
    expect(resolvedProfile?.driver).toBe("existing-session");
    expect(resolvedProfile?.attachOnly).toBe(true);
    expect(resolvedProfile?.userDataDir).toBe(userDataDir);
    expect(typeof resolvedProfile?.color).toBe("string");
  });

  it("rejects userDataDir for non-existing-session profiles", async () => {
    const resolved = resolveBrowserConfig({});
    const { ctx } = createCtx(resolved);
    vi.mocked(getRuntimeConfig).mockReturnValue({ browser: { profiles: {} } });

    const tempDir = tempDirs.make("openclaw-profile-");
    const userDataDir = path.join(tempDir, "BraveSoftware", "Brave-Browser");
    fs.mkdirSync(userDataDir, { recursive: true });

    const service = createBrowserProfilesService(ctx);

    await expect(
      service.createProfile({
        name: "brave-live",
        userDataDir,
      }),
    ).rejects.toThrow(/driver=existing-session is required/i);
  });

  it("deletes remote profiles without stopping or removing local data", async () => {
    const resolved = resolveBrowserConfig({
      profiles: {
        remote: { cdpUrl: "http://10.0.0.42:9222", color: "#0066CC" },
      },
    });
    const { ctx } = createCtx(resolved);

    vi.mocked(getRuntimeConfig).mockReturnValue({
      browser: {
        defaultProfile: "openclaw",
        profiles: {
          openclaw: { cdpPort: 18800, color: "#FF4500" },
          remote: { cdpUrl: "http://10.0.0.42:9222", color: "#0066CC" },
        },
      },
    });

    const service = createBrowserProfilesService(ctx);
    const result = await service.deleteProfile("remote");

    expect(result.deleted).toBe(false);
    expect(ctx.forProfile).not.toHaveBeenCalled();
    expect(movePathToTrash).not.toHaveBeenCalled();
  });

  it("rejects deletion when the profile became default before persistence", async () => {
    const resolved = resolveBrowserConfig({
      profiles: {
        work: { cdpUrl: "http://10.0.0.42:9222", color: "#0066CC" },
      },
    });
    const { ctx, state } = createCtx(resolved);

    vi.mocked(getRuntimeConfig)
      .mockReturnValueOnce({
        browser: {
          defaultProfile: "openclaw",
          profiles: {
            openclaw: { cdpPort: 18800, color: "#FF4500" },
            work: { cdpUrl: "http://10.0.0.42:9222", color: "#0066CC" },
          },
        },
      })
      .mockReturnValue({
        browser: {
          defaultProfile: "work",
          profiles: {
            openclaw: { cdpPort: 18800, color: "#FF4500" },
            work: { cdpUrl: "http://10.0.0.42:9222", color: "#0066CC" },
          },
        },
      });

    const service = createBrowserProfilesService(ctx);
    await expect(service.deleteProfile("work")).rejects.toThrow(
      'cannot delete the default profile "work"',
    );

    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(state.resolved.profiles).toHaveProperty("work");
    expect(state.profiles.has("work")).toBe(true);
    expect(ctx.forProfile).not.toHaveBeenCalled();
    expect(movePathToTrash).not.toHaveBeenCalled();
  });

  it("deletes local profiles and moves data to Trash", async () => {
    const resolved = resolveBrowserConfig({
      profiles: {
        work: { cdpPort: 18801, color: "#0066CC" },
      },
    });
    const { ctx } = createCtx(resolved);

    vi.mocked(getRuntimeConfig).mockReturnValue({
      browser: {
        defaultProfile: "openclaw",
        profiles: {
          openclaw: { cdpPort: 18800, color: "#FF4500" },
          work: { cdpPort: 18801, color: "#0066CC" },
        },
      },
    });

    const tempDir = tempDirs.make("openclaw-profile-");
    const userDataDir = path.join(tempDir, "work", "user-data");
    fs.mkdirSync(path.dirname(userDataDir), { recursive: true });
    vi.mocked(resolveOpenClawUserDataDir).mockReturnValue(userDataDir);

    const service = createBrowserProfilesService(ctx);
    const result = await service.deleteProfile("work");

    expect(result.deleted).toBe(true);
    expect(movePathToTrash).toHaveBeenCalledWith(path.dirname(userDataDir));
  });

  it("keeps local data and reports deleted=false when Trash rejects", async () => {
    const resolved = resolveBrowserConfig({
      profiles: { work: { cdpPort: 18801, color: "#0066CC" } },
    });
    const { ctx, state } = createCtx(resolved);
    vi.mocked(getRuntimeConfig).mockReturnValue({
      browser: {
        defaultProfile: "openclaw",
        profiles: {
          openclaw: { cdpPort: 18800, color: "#FF4500" },
          work: { cdpPort: 18801, color: "#0066CC" },
        },
      },
    });
    const tempDir = tempDirs.make("openclaw-trash-failure-");
    const userDataDir = path.join(tempDir, "work", "user-data");
    fs.mkdirSync(path.dirname(userDataDir), { recursive: true });
    vi.mocked(resolveOpenClawUserDataDir).mockReturnValue(userDataDir);
    vi.mocked(movePathToTrash).mockRejectedValueOnce(new Error("Trash unavailable"));

    const result = await createBrowserProfilesService(ctx).deleteProfile("work");

    expect(result.deleted).toBe(false);
    expect(state.resolved.profiles).not.toHaveProperty("work");
    expect(state.profiles.has("work")).toBe(false);
    expect(fs.existsSync(path.dirname(userDataDir))).toBe(true);
  });

  it("cleans a pending managed start before persisting deletion", async () => {
    const resolved = resolveBrowserConfig({
      profiles: { work: { cdpPort: 18801, color: "#0066CC" } },
    });
    const { ctx, state } = createCtx(resolved);
    vi.mocked(getRuntimeConfig).mockReturnValue({
      browser: {
        profiles: {
          openclaw: { cdpPort: 18800, color: "#FF4500" },
          work: { cdpPort: 18801, color: "#0066CC" },
        },
      },
    });
    const profile = resolveProfile(resolved, "work");
    if (!profile) {
      throw new Error("Expected work profile");
    }
    const runtime = getOrCreateProfileRuntime(state, profile);
    const tempDir = tempDirs.make("openclaw-delete-race-");
    const userDataDir = path.join(tempDir, "work", "user-data");
    fs.mkdirSync(userDataDir, { recursive: true });
    vi.mocked(resolveOpenClawUserDataDir).mockReturnValue(userDataDir);
    const launch = deferred();
    const entered = deferred();
    const running = {
      pid: 42,
      exe: { kind: "chromium", path: "/usr/bin/chromium" },
      userDataDir,
      cdpPort: 18801,
      startedAt: Date.now(),
      proc: { on: vi.fn(), exitCode: null, signalCode: null },
    } as unknown as import("./chrome.js").RunningChrome;
    const starting = enqueueProfileStart({
      state,
      runtime,
      configRevision: 0,
      key: "default",
      run: async () => {
        entered.resolve();
        await launch.promise;
        registerProfileHandle(runtime, running);
        runtime.running = running;
      },
    });
    const startExpectation = expect(starting).rejects.toThrow(/deletion|lifecycle changed/i);
    await entered.promise;
    const order: string[] = [];
    lifecycleMocks.stopOpenClawChrome.mockImplementationOnce(async () => {
      order.push("stop");
    });
    configMocks.writeConfigFile.mockImplementationOnce(async () => {
      order.push("config");
    });
    vi.mocked(movePathToTrash).mockImplementationOnce(async (targetPath) => {
      order.push("trash");
      return targetPath;
    });

    const deleting = createBrowserProfilesService(ctx).deleteProfile("work");
    launch.resolve();
    await Promise.all([startExpectation, deleting]);

    expect(order).toEqual(["stop", "config", "trash"]);
    expect(state.profiles.has("work")).toBe(false);
  });

  it("rolls back a delete tombstone when config persistence fails after cleanup", async () => {
    const resolved = resolveBrowserConfig({
      profiles: { work: { cdpPort: 18801, color: "#0066CC" } },
    });
    const { ctx, state } = createCtx(resolved);
    vi.mocked(getRuntimeConfig).mockReturnValue({
      browser: {
        profiles: {
          openclaw: { cdpPort: 18800, color: "#FF4500" },
          work: { cdpPort: 18801, color: "#0066CC" },
        },
      },
    });
    const profile = resolveProfile(resolved, "work");
    if (!profile) {
      throw new Error("Expected work profile");
    }
    const runtime = getOrCreateProfileRuntime(state, profile);
    configMocks.writeConfigFile.mockRejectedValueOnce(new Error("config write failed"));

    await expect(createBrowserProfilesService(ctx).deleteProfile("work")).rejects.toThrow(
      "config write failed",
    );

    expect(getProfileLifecycle(runtime).terminal).toBeNull();
    expect(getProfileLifecycle(runtime).blockedReason).toBeNull();
    expect(state.resolved.profiles.work).toEqual({ cdpPort: 18801, color: "#0066CC" });
    expect(movePathToTrash).not.toHaveBeenCalled();
    await expect(
      enqueueProfileStart({
        state,
        runtime,
        configRevision: getProfileLifecycle(runtime).configRevision,
        key: "default",
        run: async () => {},
      }),
    ).resolves.toBeUndefined();
  });

  it("deletes existing-session profiles without touching local browser data", async () => {
    const resolved = resolveBrowserConfig({
      profiles: {
        "chrome-live": {
          cdpPort: 18801,
          color: "#0066CC",
          driver: "existing-session",
          attachOnly: true,
        },
      },
    });
    const { ctx } = createCtx(resolved);

    vi.mocked(getRuntimeConfig).mockReturnValue({
      browser: {
        defaultProfile: "openclaw",
        profiles: {
          openclaw: { cdpPort: 18800, color: "#FF4500" },
          "chrome-live": {
            cdpPort: 18801,
            color: "#0066CC",
            driver: "existing-session",
            attachOnly: true,
          },
        },
      },
    });

    const service = createBrowserProfilesService(ctx);
    const result = await service.deleteProfile("chrome-live");

    expect(result.deleted).toBe(false);
    expect(ctx.forProfile).not.toHaveBeenCalled();
    expect(movePathToTrash).not.toHaveBeenCalled();
  });

  it("deletes attach-only openclaw profiles without touching local browser data", async () => {
    const resolved = resolveBrowserConfig({
      profiles: {
        work: {
          cdpPort: 18801,
          color: "#0066CC",
        },
      },
    });
    const { ctx } = createCtx(resolved);
    vi.mocked(getRuntimeConfig).mockReturnValue({
      browser: {
        defaultProfile: "openclaw",
        profiles: {
          openclaw: { cdpPort: 18800, color: "#FF4500" },
          work: {
            cdpPort: 18801,
            color: "#0066CC",
            driver: "openclaw",
            attachOnly: true,
          },
        },
      },
    });

    const result = await createBrowserProfilesService(ctx).deleteProfile("work");

    expect(result.deleted).toBe(false);
    expect(resolveOpenClawUserDataDir).not.toHaveBeenCalled();
    expect(movePathToTrash).not.toHaveBeenCalled();
  });

  it("preserves a same-name replacement config that appears during lifecycle drain", async () => {
    const originalProfile = { cdpPort: 18801, color: "#0066CC" };
    let currentConfig: OpenClawConfig = {
      browser: {
        defaultProfile: "openclaw",
        profiles: {
          openclaw: { cdpPort: 18800, color: "#FF4500" },
          work: originalProfile,
        },
      },
    };
    vi.mocked(getRuntimeConfig).mockImplementation(() => currentConfig);
    const resolved = resolveBrowserConfig({ profiles: { work: originalProfile } });
    const { ctx, state } = createCtx(resolved);
    const profile = resolveProfile(resolved, "work");
    if (!profile) {
      throw new Error("Expected work profile");
    }
    const runtime = getOrCreateProfileRuntime(state, profile);
    const entered = deferred();
    const release = deferred();
    const starting = enqueueProfileStart({
      state,
      runtime,
      configRevision: 0,
      key: "default",
      run: async (signal) => {
        entered.resolve();
        await release.promise;
        signal.throwIfAborted();
      },
    });
    const startExpectation = expect(starting).rejects.toThrow(/deletion|lifecycle changed/i);
    await entered.promise;

    const deleting = createBrowserProfilesService(ctx).deleteProfile("work");
    const deleteExpectation = expect(deleting).rejects.toThrow(
      'profile "work" changed while deletion was pending; retry the delete request',
    );
    currentConfig = {
      browser: {
        defaultProfile: "openclaw",
        profiles: {
          openclaw: { cdpPort: 18800, color: "#FF4500" },
          work: { cdpPort: 18802, color: "#00AA00" },
        },
      },
    };
    release.resolve();

    await Promise.all([startExpectation, deleteExpectation]);
    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(movePathToTrash).not.toHaveBeenCalled();
    expect(state.profiles.get("work")).toBe(runtime);
    expect(getProfileLifecycle(runtime).terminal).toBeNull();
    expect(getProfileLifecycle(runtime).blockedReason).toBeNull();
    await expect(
      enqueueProfileStart({
        state,
        runtime,
        configRevision: getProfileLifecycle(runtime).configRevision,
        key: "after-drift",
        run: async () => {},
      }),
    ).resolves.toBeUndefined();
  });
});
