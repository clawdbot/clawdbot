// Verifies startup environment merge behavior for Node subprocesses.
import { describe, expect, it } from "vitest";
import { LINUX_CA_BUNDLE_PATHS } from "./node-extra-ca-certs.js";
import { resolveNodeStartupTlsEnvironment } from "./node-startup-env.js";

function allowOnly(path: string) {
  return (candidate: string) => {
    if (candidate !== path) {
      throw new Error("ENOENT");
    }
  };
}

describe("resolveNodeStartupTlsEnvironment", () => {
  it("defaults macOS launch env values", () => {
    expect(
      resolveNodeStartupTlsEnvironment({
        env: {},
        platform: "darwin",
      }),
    ).toEqual({
      NODE_EXTRA_CA_CERTS: "/etc/ssl/cert.pem",
      NODE_USE_SYSTEM_CA: "1",
    });
  });

  it("keeps user-provided env values", () => {
    expect(
      resolveNodeStartupTlsEnvironment({
        env: {
          NODE_EXTRA_CA_CERTS: "/custom/ca.pem",
          NODE_USE_SYSTEM_CA: "0",
        },
        platform: "darwin",
      }),
    ).toEqual({
      NODE_EXTRA_CA_CERTS: "/custom/ca.pem",
      NODE_USE_SYSTEM_CA: "0",
    });
  });

  it("resolves Linux CA env for version-manager Node runtimes", () => {
    expect(
      resolveNodeStartupTlsEnvironment({
        env: { NVM_DIR: "/home/test/.nvm" },
        platform: "linux",
        execPath: "/usr/bin/node",
        accessSync: allowOnly(LINUX_CA_BUNDLE_PATHS[1]),
      }),
    ).toEqual({
      NODE_EXTRA_CA_CERTS: LINUX_CA_BUNDLE_PATHS[1],
      NODE_USE_SYSTEM_CA: undefined,
    });
  });

  it("can skip macOS defaults for CLI-only pre-start planning", () => {
    expect(
      resolveNodeStartupTlsEnvironment({
        env: {},
        platform: "darwin",
        includeDarwinDefaults: false,
      }),
    ).toEqual({
      NODE_EXTRA_CA_CERTS: undefined,
      NODE_USE_SYSTEM_CA: undefined,
    });
  });

  it("uses the Linux CA bundle heuristic when available", () => {
    const value = resolveNodeStartupTlsEnvironment({
      env: { NVM_DIR: "/home/test/.nvm" },
      platform: "linux",
      execPath: "/usr/bin/node",
      accessSync: allowOnly(LINUX_CA_BUNDLE_PATHS[2]),
    }).NODE_EXTRA_CA_CERTS;
    if (value !== undefined) {
      expect(LINUX_CA_BUNDLE_PATHS).toContain(value);
    }
  });
});
