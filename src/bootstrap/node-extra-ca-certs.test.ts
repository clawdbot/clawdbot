// Covers automatic NODE_EXTRA_CA_CERTS discovery and validation.
import { describe, expect, it } from "vitest";
import { resolveAutoNodeExtraCaCerts } from "./node-extra-ca-certs.js";

const DEBIAN_CA_BUNDLE_PATH = "/etc/ssl/certs/ca-certificates.crt";
const FEDORA_CA_BUNDLE_PATH = "/etc/pki/tls/certs/ca-bundle.crt";
const GENERIC_CA_BUNDLE_PATH = "/etc/ssl/ca-bundle.pem";
const VERSION_MANAGER_EXEC_PATHS = [
  ["nvm", "/home/test/.nvm/versions/node/v22/bin/node"],
  ["fnm", "/home/test/.fnm/node-versions/v22/installation/bin/node"],
  ["fnm XDG data", "/home/test/.local/share/fnm/node-versions/v22/installation/bin/node"],
  ["nvs dotted home", "/home/test/.nvs/node/22.14.0/x64/bin/node"],
  ["volta", "/home/test/.volta/tools/image/node/22.14.0/bin/node"],
  ["asdf", "/home/test/.asdf/installs/nodejs/22.14.0/bin/node"],
  ["mise", "/home/test/.local/share/mise/installs/node/22.14.0/bin/node"],
  ["n", "/home/test/.n/bin/node"],
  ["nodenv", "/home/test/.nodenv/versions/22.14.0/bin/node"],
  ["nodebrew", "/home/test/.nodebrew/node/v22.14.0/bin/node"],
  ["nvs", "/home/test/nvs/node/22.14.0/x64/bin/node"],
] as const;

function allowOnly(path: string) {
  return (candidate: string) => {
    if (candidate !== path) {
      throw new Error("ENOENT");
    }
  };
}

describe("resolveAutoNodeExtraCaCerts", () => {
  it("returns undefined on non-linux platforms", () => {
    expect(
      resolveAutoNodeExtraCaCerts({
        env: { NVM_DIR: "/home/test/.nvm" },
        platform: "darwin",
        accessSync: allowOnly(DEBIAN_CA_BUNDLE_PATH),
      }),
    ).toBeUndefined();
  });

  it("returns the first readable Linux CA bundle", () => {
    expect(
      resolveAutoNodeExtraCaCerts({
        env: { NVM_DIR: "/home/test/.nvm" },
        platform: "linux",
        execPath: "/usr/bin/node",
        accessSync: allowOnly(FEDORA_CA_BUNDLE_PATH),
      }),
    ).toBe(FEDORA_CA_BUNDLE_PATH);
  });

  it.each(VERSION_MANAGER_EXEC_PATHS)("detects %s via execPath", (_manager, execPath) => {
    expect(
      resolveAutoNodeExtraCaCerts({
        env: {},
        platform: "linux",
        execPath,
        accessSync: allowOnly(GENERIC_CA_BUNDLE_PATH),
      }),
    ).toBe(GENERIC_CA_BUNDLE_PATH);
  });

  it("returns undefined when NODE_EXTRA_CA_CERTS is already set", () => {
    expect(
      resolveAutoNodeExtraCaCerts({
        env: {
          NVM_DIR: "/home/test/.nvm",
          NODE_EXTRA_CA_CERTS: "/custom/ca.pem",
        },
        platform: "linux",
        accessSync: allowOnly(DEBIAN_CA_BUNDLE_PATH),
      }),
    ).toBeUndefined();
  });

  it("returns undefined when node is not nvm-managed", () => {
    expect(
      resolveAutoNodeExtraCaCerts({
        env: {},
        platform: "linux",
        execPath: "/usr/bin/node",
        accessSync: allowOnly(DEBIAN_CA_BUNDLE_PATH),
      }),
    ).toBeUndefined();
  });

  it("returns the readable Linux CA bundle for nvm-managed node", () => {
    expect(
      resolveAutoNodeExtraCaCerts({
        env: { NVM_DIR: "/home/test/.nvm" },
        platform: "linux",
        execPath: "/usr/bin/node",
        accessSync: allowOnly(GENERIC_CA_BUNDLE_PATH),
      }),
    ).toBe(GENERIC_CA_BUNDLE_PATH);
  });
});
