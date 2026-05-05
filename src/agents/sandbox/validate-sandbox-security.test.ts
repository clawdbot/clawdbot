import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSandboxHostPathViaExistingAncestor } from "./host-paths.js";
import {
  getBlockedBindReason,
  validateBindMounts,
  validateNetworkMode,
  validateSeccompProfile,
  validateApparmorProfile,
  validateSandboxSecurity,
} from "./validate-sandbox-security.js";

function expectBindMountsToThrow(binds: string[], expected: RegExp, label: string) {
  expect(() => validateBindMounts(binds), label).toThrow(expected);
}

describe("getBlockedBindReason", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("blocks common Docker socket directories", () => {
    expect(getBlockedBindReason("/run:/run")).toEqual(expect.objectContaining({ kind: "targets" }));
    expect(getBlockedBindReason("/var/run:/var/run:ro")).toEqual(
      expect.objectContaining({ kind: "targets" }),
    );
  });

  it("does not block /var by default", () => {
    expect(getBlockedBindReason("/var:/var")).toBeNull();
  });

  it("blocks sensitive home credential paths", () => {
    vi.stubEnv("HOME", "/home/tester");

    const cases = [
      "/home/tester/.aws/credentials",
      "/home/tester/.cargo/credentials.toml",
      "/home/tester/.config/gcloud",
      "/home/tester/.docker/config.json",
      "/home/tester/.gnupg/private-keys-v1.d",
      "/home/tester/.netrc",
      "/home/tester/.npm/_logs",
      "/home/tester/.ssh/config",
    ] as const;

    for (const source of cases) {
      expect(getBlockedBindReason(`${source}:/mnt/test:ro`)).toEqual(
        expect.objectContaining({ kind: "targets" }),
      );
    }
  });

  it("still blocks OS-home credential paths when OPENCLAW_HOME points elsewhere", () => {
    vi.stubEnv("HOME", "/home/tester");
    vi.stubEnv("OPENCLAW_HOME", "/srv/openclaw-home");

    expect(getBlockedBindReason("/home/tester/.gnupg/secring.gpg:/mnt/gnupg:ro")).toEqual(
      expect.objectContaining({
        kind: "targets",
        blockedPath: "/home/tester/.gnupg",
      }),
    );
  });

  it("blocks canonical OS-home aliases for credential paths", () => {
    if (process.platform === "win32") {
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), "openclaw-home-"));
    const realHome = join(dir, "real-home");
    const aliasHome = join(dir, "alias-home");
    mkdirSync(join(realHome, ".ssh"), { recursive: true });
    symlinkSync(realHome, aliasHome);
    vi.stubEnv("HOME", aliasHome);

    expect(getBlockedBindReason(`${join(realHome, ".ssh", "config")}:/mnt/ssh:ro`)).toEqual(
      expect.objectContaining({
        kind: "targets",
        blockedPath: normalizePathForSnapshot(join(realHome, ".ssh")),
      }),
    );
  });
});

describe("validateBindMounts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows legitimate project directory mounts", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "openclaw-sbx-safe-"));
    expect(() =>
      validateBindMounts([
        `${join(projectRoot, "source")}:/source:rw`,
        `${join(projectRoot, "projects")}:/projects:ro`,
        `${join(projectRoot, "data")}:/data`,
        `${join(projectRoot, "config")}:/config:ro`,
      ]),
    ).not.toThrow();
  });

  it("allows undefined or empty binds", () => {
    expect(() => validateBindMounts(undefined)).not.toThrow();
    expect(() => validateBindMounts([])).not.toThrow();
  });

  it("blocks dangerous bind source paths", () => {
    const cases = [
      {
        name: "host root mount",
        binds: ["/:/mnt/host"],
        expected: /blocked path "\/"/,
      },
      {
        name: "etc mount",
        binds: ["/etc/passwd:/mnt/passwd:ro"],
        expected: /blocked path "\/etc"/,
      },
      {
        name: "proc mount",
        binds: ["/proc:/proc:ro"],
        expected: /blocked path "\/proc"/,
      },
      {
        name: "docker socket in /var/run",
        binds: ["/var/run/docker.sock:/var/run/docker.sock"],
        expected: /docker\.sock/,
      },
      {
        name: "docker socket in /run",
        binds: ["/run/docker.sock:/run/docker.sock"],
        expected: /docker\.sock/,
      },
      {
        name: "parent /run mount",
        binds: ["/run:/run"],
        expected: /blocked path/,
      },
      {
        name: "parent /var/run mount",
        binds: ["/var/run:/var/run"],
        expected: /blocked path/,
      },
      {
        name: "traversal into /etc",
        binds: ["/home/user/../../etc/shadow:/mnt/shadow"],
        expected: /blocked path "\/etc"/,
      },
      {
        name: "double-slash normalization into /etc",
        binds: ["//etc//passwd:/mnt/passwd"],
        expected: /blocked path "\/etc"/,
      },
    ] as const;
    for (const testCase of cases) {
      expectBindMountsToThrow([...testCase.binds], testCase.expected, testCase.name);
    }
  });

  it("allows parent mounts that are not blocked", () => {
    expect(() => validateBindMounts(["/var:/var"])).not.toThrow();
  });

  it("blocks sensitive home credential binds", () => {
    vi.stubEnv("HOME", "/home/tester");

    expect(() => validateBindMounts(["/home/tester/.docker/config.json:/mnt/docker:ro"])).toThrow(
      /blocked path/,
    );
    expect(() => validateBindMounts(["/home/tester/.netrc:/mnt/netrc:ro"])).toThrow(/blocked path/);
  });

  it("allows drive-absolute Windows bind sources", () => {
    expect(() => validateBindMounts(["D:/data/openclaw/src:/src:ro"])).not.toThrow();
    expect(() => validateBindMounts(["D:\\data\\openclaw\\output:/output:rw"])).not.toThrow();
  });

  it("compares Windows allowed roots case-insensitively", () => {
    expect(() =>
      validateBindMounts(["d:/DATA/OpenClaw/src:/src:ro"], {
        allowedSourceRoots: ["D:/data/openclaw"],
      }),
    ).not.toThrow();

    expect(() =>
      validateBindMounts(["D:/other/project:/src:ro"], {
        allowedSourceRoots: ["d:/data/openclaw"],
      }),
    ).toThrow(/outside allowed roots/);
  });

  it("blocks credential binds through canonical home aliases", () => {
    if (process.platform === "win32") {
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), "openclaw-home-"));
    const realHome = join(dir, "real-home");
    const aliasHome = join(dir, "alias-home");
    mkdirSync(join(realHome, ".docker"), { recursive: true });
    symlinkSync(realHome, aliasHome);
    vi.stubEnv("HOME", aliasHome);

    expect(() =>
      validateBindMounts([`${join(realHome, ".docker", "config.json")}:/mnt/docker:ro`]),
    ).toThrow(/credential paths/);
  });

  it("blocks symlink escapes into blocked directories", () => {
    if (process.platform === "win32") {
      // Symlink setup for blocked POSIX targets like /etc is POSIX-only.
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), "openclaw-sbx-"));
    const link = join(dir, "etc-link");
    symlinkSync("/etc", link);
    const run = () => validateBindMounts([`${link}/passwd:/mnt/passwd:ro`]);
    expect(run).toThrow(/blocked path/);
  });

  it("blocks symlink-parent escapes with non-existent leaf outside allowed roots", () => {
    if (process.platform === "win32") {
      // Windows symlink semantics differ; POSIX symlink escape coverage runs on POSIX hosts.
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "openclaw-sbx-"));
    const workspace = join(dir, "workspace");
    const outside = join(dir, "outside");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const link = join(workspace, "alias-out");
    symlinkSync(outside, link);
    const missingLeaf = join(link, "not-yet-created");
    expect(() =>
      validateBindMounts([`${missingLeaf}:/mnt/data:ro`], {
        allowedSourceRoots: [workspace],
      }),
    ).toThrow(/outside allowed roots/);
  });

  it("blocks symlink-parent escapes into blocked paths when leaf does not exist", () => {
    if (process.platform === "win32") {
      // Symlink setup for blocked POSIX targets like /var/run is POSIX-only.
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "openclaw-sbx-"));
    const workspace = join(dir, "workspace");
    mkdirSync(workspace, { recursive: true });
    const link = join(workspace, "run-link");
    symlinkSync("/var/run", link);
    const missingLeaf = join(link, "openclaw-not-created");
    expect(() =>
      validateBindMounts([`${missingLeaf}:/mnt/run:ro`], {
        allowedSourceRoots: [workspace],
      }),
    ).toThrow(/blocked path/);
  });

  it("rejects non-absolute source paths (relative or named volumes)", () => {
    const cases = ["../etc/passwd:/mnt/passwd", "etc/passwd:/mnt/passwd", "myvol:/mnt"] as const;
    for (const source of cases) {
      expectBindMountsToThrow([source], /non-absolute/, source);
    }
  });

  it("blocks bind sources outside allowed roots when allowlist is configured", () => {
    const allowedRoot = mkdtempSync(join(tmpdir(), "openclaw-sbx-allowed-root-"));
    const externalRoot = mkdtempSync(join(tmpdir(), "openclaw-sbx-external-"));
    expect(() =>
      validateBindMounts([`${externalRoot}:/data:ro`], {
        allowedSourceRoots: [allowedRoot],
      }),
    ).toThrow(/outside allowed roots/);
  });

  it("allows bind sources in allowed roots when allowlist is configured", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "openclaw-sbx-allowed-"));
    expect(() =>
      validateBindMounts([`${join(projectRoot, "cache")}:/data:ro`], {
        allowedSourceRoots: [projectRoot],
      }),
    ).not.toThrow();
  });

  it("allows bind sources outside allowed roots with explicit dangerous override", () => {
    const allowedRoot = mkdtempSync(join(tmpdir(), "openclaw-sbx-allowed-root-"));
    const externalRoot = mkdtempSync(join(tmpdir(), "openclaw-sbx-external-"));
    expect(() =>
      validateBindMounts([`${externalRoot}:/data:ro`], {
        allowedSourceRoots: [allowedRoot],
        allowSourcesOutsideAllowedRoots: true,
      }),
    ).not.toThrow();
  });

  it("blocks reserved container target paths by default", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "openclaw-sbx-reserved-default-"));
    expect(() =>
      validateBindMounts([`${projectRoot}:/workspace:rw`, `${projectRoot}:/agent/cache:rw`]),
    ).toThrow(/reserved container path/);
  });

  it("allows reserved container target paths with explicit dangerous override", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "openclaw-sbx-reserved-"));
    expect(() =>
      validateBindMounts([`${projectRoot}:/workspace:rw`], {
        allowReservedContainerTargets: true,
      }),
    ).not.toThrow();
  });
});

function normalizePathForSnapshot(input: string): string {
  return resolveSandboxHostPathViaExistingAncestor(input).replaceAll("\\", "/");
}

describe("validateNetworkMode", () => {
  it("allows bridge/none/custom/undefined", () => {
    expect(() => validateNetworkMode("bridge")).not.toThrow();
    expect(() => validateNetworkMode("none")).not.toThrow();
    expect(() => validateNetworkMode("my-custom-network")).not.toThrow();
    expect(() => validateNetworkMode(undefined)).not.toThrow();
  });

  it("blocks host mode (case-insensitive)", () => {
    const cases = [
      { mode: "host", expected: /network mode "host" is blocked/ },
      { mode: "HOST", expected: /network mode "HOST" is blocked/ },
    ] as const;
    for (const testCase of cases) {
      expect(() => validateNetworkMode(testCase.mode), testCase.mode).toThrow(testCase.expected);
    }
  });

  it("blocks container namespace joins by default", () => {
    const cases = [
      {
        mode: "container:abc123",
        expected: /network mode "container:abc123" is blocked by default/,
      },
      {
        mode: "CONTAINER:ABC123",
        expected: /network mode "CONTAINER:ABC123" is blocked by default/,
      },
    ] as const;
    for (const testCase of cases) {
      expect(() => validateNetworkMode(testCase.mode), testCase.mode).toThrow(testCase.expected);
    }
  });

  it("allows container namespace joins with explicit dangerous override", () => {
    expect(() =>
      validateNetworkMode("container:abc123", {
        allowContainerNamespaceJoin: true,
      }),
    ).not.toThrow();
  });
});

describe("validateSeccompProfile", () => {
  it("allows custom profile paths/undefined", () => {
    expect(() => validateSeccompProfile("/tmp/seccomp.json")).not.toThrow();
    expect(() => validateSeccompProfile(undefined)).not.toThrow();
  });
});

describe("validateApparmorProfile", () => {
  it("allows named profile/undefined", () => {
    expect(() => validateApparmorProfile("openclaw-sandbox")).not.toThrow();
    expect(() => validateApparmorProfile(undefined)).not.toThrow();
  });
});

describe("profile hardening", () => {
  it.each([
    {
      name: "seccomp",
      run: (value: string) => validateSeccompProfile(value),
      expected: /seccomp profile ".+" is blocked/,
    },
    {
      name: "apparmor",
      run: (value: string) => validateApparmorProfile(value),
      expected: /apparmor profile ".+" is blocked/,
    },
  ])("blocks unconfined profiles (case-insensitive): $name", ({ run, expected }) => {
    expect(() => run("unconfined")).toThrow(expected);
    expect(() => run("Unconfined")).toThrow(expected);
  });
});

describe("validateSandboxSecurity", () => {
  it("passes with safe config", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "openclaw-sbx-safe-config-"));
    expect(() =>
      validateSandboxSecurity({
        binds: [`${projectRoot}:/src:rw`],
        network: "none",
        seccompProfile: "/tmp/seccomp.json",
        apparmorProfile: "openclaw-sandbox",
      }),
    ).not.toThrow();
  });
});
