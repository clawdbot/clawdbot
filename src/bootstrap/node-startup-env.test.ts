// Verifies startup environment merge behavior for Node subprocesses.
import { describe, expect, it } from "vitest";
import { resolveNodeStartupTlsEnvironment } from "./node-startup-env.js";

const FEDORA_CA_BUNDLE_PATH = "/etc/pki/tls/certs/ca-bundle.crt";
const GENERIC_CA_BUNDLE_PATH = "/etc/ssl/ca-bundle.pem";

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
        accessSync: allowOnly(FEDORA_CA_BUNDLE_PATH),
      }),
    ).toEqual({
      NODE_EXTRA_CA_CERTS: FEDORA_CA_BUNDLE_PATH,
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
      accessSync: allowOnly(GENERIC_CA_BUNDLE_PATH),
    }).NODE_EXTRA_CA_CERTS;
    expect(value).toBe(GENERIC_CA_BUNDLE_PATH);
  });
});
