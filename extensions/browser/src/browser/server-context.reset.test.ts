import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProfileResetOps } from "./server-context.reset.js";

const trashMocks = vi.hoisted(() => ({
  movePathToTrash: vi.fn(async (from: string) => `${from}.trashed`),
}));

const pwAiMocks = vi.hoisted(() => ({
  closePlaywrightBrowserConnection: vi.fn(async () => {}),
}));

vi.mock("./trash.js", () => trashMocks);
vi.mock("./pw-ai.js", () => pwAiMocks);

afterEach(() => {
  vi.clearAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
});

function localOpenClawProfile(): Parameters<typeof createProfileResetOps>[0]["profile"] {
  return {
    name: "openclaw",
    cdpUrl: "http://127.0.0.1:18800",
    cdpHost: "127.0.0.1",
    cdpIsLoopback: true,
    cdpPort: 18800,
    color: "#f60",
    driver: "openclaw",
    attachOnly: false,
  };
}

function createLocalOpenClawResetOps(
  params: Omit<Parameters<typeof createProfileResetOps>[0], "profile">,
) {
  return createProfileResetOps({ profile: localOpenClawProfile(), ...params });
}

function createStatelessResetOps(profile: Parameters<typeof createProfileResetOps>[0]["profile"]) {
  return createProfileResetOps({
    profile,
    getProfileState: () => ({ profile: {} as never, running: null }),
    stopRunningBrowser: vi.fn(async () => ({ stopped: false })),
    isHttpReachable: vi.fn(async () => false),
    resolveOpenClawUserDataDir: (name: string) => `/tmp/${name}`,
  });
}

describe("createProfileResetOps", () => {
  it("rejects remote non-extension profiles", async () => {
    const ops = createStatelessResetOps({
      ...localOpenClawProfile(),
      name: "remote",
      cdpUrl: "https://browserless.example/chrome",
      cdpHost: "browserless.example",
      cdpIsLoopback: false,
      cdpPort: 443,
      color: "#0f0",
    });

    await expect(ops.resetProfile()).rejects.toThrow(/only supported for local profiles/i);
  });

  it("stops local browser, closes playwright connection, and trashes profile dir", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reset-"));
    const profileDir = path.join(tempRoot, "openclaw");
    fs.mkdirSync(profileDir, { recursive: true });

    const stopRunningBrowser = vi.fn(async () => ({ stopped: true }));
    const isHttpReachable = vi.fn(async () => true);
    const getProfileState = vi.fn(() => ({
      profile: {} as never,
      running: { pid: 1 } as never,
    }));

    const ops = createLocalOpenClawResetOps({
      getProfileState,
      stopRunningBrowser,
      isHttpReachable,
      resolveOpenClawUserDataDir: () => profileDir,
    });

    const result = await ops.resetProfile();
    expect(result).toEqual({
      moved: true,
      from: profileDir,
      to: `${profileDir}.trashed`,
    });
    expect(isHttpReachable).toHaveBeenCalledWith(300);
    expect(stopRunningBrowser).toHaveBeenCalledTimes(1);
    expect(pwAiMocks.closePlaywrightBrowserConnection).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18800",
    });
    expect(trashMocks.movePathToTrash).toHaveBeenCalledWith(profileDir);
  });

  it("forces playwright disconnect when loopback cdp is occupied by non-owned process", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reset-no-own-"));
    const profileDir = path.join(tempRoot, "openclaw");
    fs.mkdirSync(profileDir, { recursive: true });

    const stopRunningBrowser = vi.fn(async () => ({ stopped: false }));
    const ops = createLocalOpenClawResetOps({
      getProfileState: () => ({ profile: {} as never, running: null }),
      stopRunningBrowser,
      isHttpReachable: vi.fn(async () => true),
      resolveOpenClawUserDataDir: () => profileDir,
    });

    await ops.resetProfile();
    expect(stopRunningBrowser).not.toHaveBeenCalled();
    expect(pwAiMocks.closePlaywrightBrowserConnection).toHaveBeenCalledTimes(2);
    expect(pwAiMocks.closePlaywrightBrowserConnection).toHaveBeenNthCalledWith(1, {
      cdpUrl: "http://127.0.0.1:18800",
    });
    expect(pwAiMocks.closePlaywrightBrowserConnection).toHaveBeenNthCalledWith(2, {
      cdpUrl: "http://127.0.0.1:18800",
    });
  });
});
