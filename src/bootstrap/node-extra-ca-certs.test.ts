// Covers automatic NODE_EXTRA_CA_CERTS discovery and validation.
import { describe, expect, it } from "vitest";
import {
  isNodeVersionManagerRuntime,
  LINUX_CA_BUNDLE_PATHS,
  resolveAutoNodeExtraCaCerts,
  resolveLinuxSystemCaBundle,
} from "./node-extra-ca-certs.js";

function allowOnly(path: string) {
  return (candidate: string) => {
    if (candidate !== path) {
      throw new Error("ENOENT");
    }
  };
}

describe("resolveLinuxSystemCaBundle", () => {
  it("returns undefined on non-linux platforms", () => {
    expect(
      resolveLinuxSystemCaBundle({
        platform: "darwin",
        accessSync: allowOnly(LINUX_CA_BUNDLE_PATHS[0]),
      }),
    ).toBeUndefined();
  });

  it("returns the first readable Linux CA bundle", () => {
    expect(
      resolveLinuxSystemCaBundle({
        platform: "linux",
        accessSync: allowOnly(LINUX_CA_BUNDLE_PATHS[1]),
      }),
    ).toBe(LINUX_CA_BUNDLE_PATHS[1]);
  });
});

describe("isNodeVersionManagerRuntime", () => {
  it("detects nvm via NVM_DIR", () => {
    expect(isNodeVersionManagerRuntime({ NVM_DIR: "/home/test/.nvm" }, "/usr/bin/node")).toBe(true);
  });

  it("detects nvm via execPath", () => {
    expect(isNodeVersionManagerRuntime({}, "/home/test/.nvm/versions/node/v22/bin/node")).toBe(
      true,
    );
  });

  it("returns false for non-nvm node paths", () => {
    expect(isNodeVersionManagerRuntime({}, "/usr/bin/node")).toBe(false);
  });

  it("detects fnm via execPath", () => {
    expect(
      isNodeVersionManagerRuntime({}, "/home/test/.fnm/node-versions/v22/installation/bin/node"),
    ).toBe(true);
  });

  it("detects fnm via XDG data path", () => {
    expect(
      isNodeVersionManagerRuntime(
        {},
        "/home/test/.local/share/fnm/node-versions/v22/installation/bin/node",
      ),
    ).toBe(true);
  });

  it("detects nvs via dotted home path", () => {
    expect(isNodeVersionManagerRuntime({}, "/home/test/.nvs/node/22.14.0/x64/bin/node")).toBe(true);
  });

  it("detects volta via execPath", () => {
    expect(
      isNodeVersionManagerRuntime({}, "/home/test/.volta/tools/image/node/22.14.0/bin/node"),
    ).toBe(true);
  });

  it("detects asdf via execPath", () => {
    expect(
      isNodeVersionManagerRuntime({}, "/home/test/.asdf/installs/nodejs/22.14.0/bin/node"),
    ).toBe(true);
  });

  it("detects mise via execPath", () => {
    expect(
      isNodeVersionManagerRuntime(
        {},
        "/home/test/.local/share/mise/installs/node/22.14.0/bin/node",
      ),
    ).toBe(true);
  });

  it("detects n via execPath", () => {
    expect(isNodeVersionManagerRuntime({}, "/home/test/.n/bin/node")).toBe(true);
  });

  it("detects nodenv via execPath", () => {
    expect(isNodeVersionManagerRuntime({}, "/home/test/.nodenv/versions/22.14.0/bin/node")).toBe(
      true,
    );
  });

  it("detects nodebrew via execPath", () => {
    expect(isNodeVersionManagerRuntime({}, "/home/test/.nodebrew/node/v22.14.0/bin/node")).toBe(
      true,
    );
  });

  it("detects nvs via execPath", () => {
    expect(isNodeVersionManagerRuntime({}, "/home/test/nvs/node/22.14.0/x64/bin/node")).toBe(true);
  });
});

describe("resolveAutoNodeExtraCaCerts", () => {
  it("returns undefined when NODE_EXTRA_CA_CERTS is already set", () => {
    expect(
      resolveAutoNodeExtraCaCerts({
        env: {
          NVM_DIR: "/home/test/.nvm",
          NODE_EXTRA_CA_CERTS: "/custom/ca.pem",
        },
        platform: "linux",
        accessSync: allowOnly(LINUX_CA_BUNDLE_PATHS[0]),
      }),
    ).toBeUndefined();
  });

  it("returns undefined when node is not nvm-managed", () => {
    expect(
      resolveAutoNodeExtraCaCerts({
        env: {},
        platform: "linux",
        execPath: "/usr/bin/node",
        accessSync: allowOnly(LINUX_CA_BUNDLE_PATHS[0]),
      }),
    ).toBeUndefined();
  });

  it("returns the readable Linux CA bundle for nvm-managed node", () => {
    expect(
      resolveAutoNodeExtraCaCerts({
        env: { NVM_DIR: "/home/test/.nvm" },
        platform: "linux",
        execPath: "/usr/bin/node",
        accessSync: allowOnly(LINUX_CA_BUNDLE_PATHS[2]),
      }),
    ).toBe(LINUX_CA_BUNDLE_PATHS[2]);
  });
});
