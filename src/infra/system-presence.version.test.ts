import os from "node:os";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { VERSION as runtimeVersion } from "../version.js";

vi.unmock("../version.js");

async function withPresenceModule<T>(
  env: Record<string, string | undefined>,
  run: (module: typeof import("./system-presence.js")) => Promise<T> | T,
): Promise<T> {
  return withEnvAsync(
    {
      OPENCLAW_VERSION: undefined,
      OPENCLAW_SERVICE_VERSION: undefined,
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
  afterEach(() => {
    vi.restoreAllMocks();
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

  it("uses runtime VERSION when OPENCLAW_VERSION is not set", async () => {
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
        OPENCLAW_SERVICE_VERSION: "2.4.6-service",
        npm_package_version: "1.0.0-package",
      },
      "9.9.9-cli",
    );
  });

  it("still prefers runtime VERSION over OPENCLAW_SERVICE_VERSION when OPENCLAW_VERSION is blank", async () => {
    await expectSelfVersion(
      {
        OPENCLAW_VERSION: " ",
        OPENCLAW_SERVICE_VERSION: "2.4.6-service",
        npm_package_version: "1.0.0-package",
      },
      runtimeVersion,
    );
  });

  it("still prefers runtime VERSION over npm_package_version when service markers are blank", async () => {
    await expectSelfVersion(
      {
        OPENCLAW_VERSION: " ",
        OPENCLAW_SERVICE_VERSION: "\t",
        npm_package_version: "1.0.0-package",
      },
      runtimeVersion,
    );
  });

  it("uses runtime VERSION when OPENCLAW_VERSION and OPENCLAW_SERVICE_VERSION are blank", async () => {
    await expectSelfVersion(
      {
        OPENCLAW_VERSION: " ",
        OPENCLAW_SERVICE_VERSION: "\t",
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
});
