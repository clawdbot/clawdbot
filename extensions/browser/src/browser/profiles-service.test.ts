import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveOpenClawUserDataDir } from "./chrome.js";
import type { BrowserRouteContext, BrowserServerState } from "./server-context.js";
import { movePathToTrash } from "./trash.js";

const configMocks = vi.hoisted(() => ({
  writeConfigFile: vi.fn<(cfg: OpenClawConfig) => Promise<void>>(async (_cfg) => {}),
}));
const writeConfigFile = configMocks.writeConfigFile;

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: vi.fn(),
    replaceConfigFile: vi.fn(async ({ nextConfig }: { nextConfig: OpenClawConfig }) => {
      await configMocks.writeConfigFile(nextConfig);
    }),
  };
});

vi.mock("./trash.js", () => ({
  movePathToTrash: vi.fn(async (targetPath: string) => targetPath),
}));

vi.mock("./chrome.js", () => ({
  resolveOpenClawUserDataDir: vi.fn(() => "/tmp/openclaw-test/openclaw/user-data"),
}));

const [{ resolveBrowserConfig }, { createBrowserProfilesService }] = await Promise.all([
  import("./config.js"),
  import("./profiles-service.js"),
]);

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
  const cfg = writeConfigFile.mock.calls[0]?.[0] as { browser?: Record<string, unknown> };
  expect(cfg?.browser).toBeDefined();
  return cfg.browser ?? {};
}

describe("BrowserProfilesService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("allocates from configured cdpPortRangeStart for new local profiles", async () => {
    const { result, state } = await createWorkProfileWithConfig({
      resolved: resolveBrowserConfig({ cdpPortRangeStart: 19000 }),
      browserConfig: { cdpPortRangeStart: 19000, profiles: {} },
    });

    expect(result.cdpPort).toBe(19001);
    expect(result.isRemote).toBe(false);
    expect(state.resolved.profiles.work?.cdpPort).toBe(19001);
    expect(writeConfigFile).toHaveBeenCalled();
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

  it("rejects driver=existing-session when cdpUrl is provided", async () => {
    const resolved = resolveBrowserConfig({});
    const { ctx } = createCtx(resolved);
    vi.mocked(getRuntimeConfig).mockReturnValue({ browser: { profiles: {} } });

    const service = createBrowserProfilesService(ctx);

    await expect(
      service.createProfile({
        name: "chrome-live",
        driver: "existing-session",
        cdpUrl: "http://127.0.0.1:9222",
      }),
    ).rejects.toThrow(/does not accept cdpUrl/i);
  });

  it("creates existing-session profiles with an explicit userDataDir", async () => {
    const resolved = resolveBrowserConfig({});
    const { ctx, state } = createCtx(resolved);
    vi.mocked(getRuntimeConfig).mockReturnValue({ browser: { profiles: {} } });

    const tempDir = fs.mkdtempSync(path.join("/tmp", "openclaw-profile-"));
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

    const tempDir = fs.mkdtempSync(path.join("/tmp", "openclaw-profile-"));
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

    const tempDir = fs.mkdtempSync(path.join("/tmp", "openclaw-profile-"));
    const userDataDir = path.join(tempDir, "work", "user-data");
    fs.mkdirSync(path.dirname(userDataDir), { recursive: true });
    vi.mocked(resolveOpenClawUserDataDir).mockReturnValue(userDataDir);

    const service = createBrowserProfilesService(ctx);
    const result = await service.deleteProfile("work");

    expect(result.deleted).toBe(true);
    expect(movePathToTrash).toHaveBeenCalledWith(path.dirname(userDataDir));
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
});
