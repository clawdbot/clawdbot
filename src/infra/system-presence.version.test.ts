// Tests system command version probing for presence checks.
import os from "node:os";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { VERSION as runtimeVersion } from "../version.js";

vi.unmock("../version.js");

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessSpawnSync } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeChildProcessSpawnSync(spawnSyncMock, () =>
    vi.importActual<typeof import("node:child_process")>("node:child_process"),
  );
});

async function withPresenceModule<T>(
  env: Record<string, string | undefined>,
  run: (module: typeof import("./system-presence.js")) => Promise<T> | T,
): Promise<T> {
  return withEnvAsync(
    {
      OPENCLAW_VERSION: undefined,
      npm_package_version: undefined,
      ...env,
    },
    async () => {
      const module = await importFreshModule<typeof import("./system-presence.js")>(
        import.meta.url,
        `./system-presence.js?scope=${JSON.stringify(env)}`,
      );
      return await run(module);
    },
  );
}

describe("system-presence version fallback", () => {
  beforeEach(() => {
    vi.resetModules();
    spawnSyncMock.mockReturnValue({
      stdout: "",
      stderr: "",
      pid: 1,
      output: [],
      status: 0,
      signal: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    spawnSyncMock.mockReset();
  });

  async function expectSelfVersion(
    env: Record<string, string | undefined>,
    expectedVersion: string | (() => Promise<string>),
  ) {
    await withPresenceModule(env, async ({ listSystemPresence }) => {
      const selfEntry = listSystemPresence().find((entry) => entry.reason === "self");
      const resolvedExpected =
        typeof expectedVersion === "function" ? await expectedVersion() : expectedVersion;
      expect(selfEntry?.version).toBe(resolvedExpected);
    });
  }

  it("ignores legacy service metadata and uses runtime VERSION", async () => {
    await expectSelfVersion(
      {
        OPENCLAW_SERVICE_VERSION: "2.4.6-service",
        npm_package_version: "1.0.0-package",
      },
      runtimeVersion,
    );
  });

  it("prefers OPENCLAW_VERSION over runtime VERSION", async () => {
    await expectSelfVersion(
      {
        OPENCLAW_VERSION: "9.9.9-cli",
        npm_package_version: "1.0.0-package",
      },
      "9.9.9-cli",
    );
  });

  it("uses runtime VERSION when OPENCLAW_VERSION is blank despite npm_package_version", async () => {
    await expectSelfVersion(
      {
        OPENCLAW_VERSION: " ",
        npm_package_version: "1.0.0-package",
      },
      runtimeVersion,
    );
  });

  it("falls back to hostname when self-presence LAN discovery throws", async () => {
    await withEnvAsync({}, async () => {
      vi.spyOn(os, "hostname").mockReturnValue("test-host");
      vi.spyOn(os, "networkInterfaces").mockImplementation(() => {
        throw new Error("uv_interface_addresses failed");
      });
      const module = await importFreshModule<typeof import("./system-presence.js")>(
        import.meta.url,
        "./system-presence.js?scope=hostname-fallback",
      );
      const selfEntry = module.listSystemPresence().find((entry) => entry.reason === "self");
      expect(selfEntry?.host).toBe("test-host");
      expect(selfEntry?.ip).toBe("test-host");
    });
  });

  it("bounds macOS self-presence metadata probes", async () => {
    vi.spyOn(os, "platform").mockReturnValue("darwin");
    vi.spyOn(os, "release").mockReturnValue("25.0.0");
    vi.spyOn(os, "arch").mockReturnValue("arm64");
    vi.spyOn(os, "hostname").mockReturnValue("test-mac");
    vi.spyOn(os, "networkInterfaces").mockReturnValue({});
    spawnSyncMock.mockImplementation((command: string) => ({
      stdout: command === "sysctl" ? "Mac16,1\n" : "26.0\n",
      stderr: "",
      pid: 1,
      output: [],
      status: 0,
      signal: null,
    }));

    await withPresenceModule({}, ({ listSystemPresence }) => {
      const selfEntry = listSystemPresence().find((entry) => entry.reason === "self");
      expect(selfEntry?.modelIdentifier).toBe("Mac16,1");
      expect(selfEntry?.platform).toBe("macos 26.0");
    });

    expect(spawnSyncMock).toHaveBeenCalledWith("sysctl", ["-n", "hw.model"], {
      encoding: "utf-8",
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    expect(spawnSyncMock).toHaveBeenCalledWith("sw_vers", ["-productVersion"], {
      encoding: "utf-8",
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
  });
});
