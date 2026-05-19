import { execFileSync } from "node:child_process";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withMockedPlatform, withRestoredMocks } from "../test-utils/vitest-spies.js";
import { createNpmFreshnessBypassArgs, createNpmProjectInstallEnv } from "./npm-install-env.js";

const FROZEN_NOW = new Date("2026-05-18T19:55:00.000Z");
const EXPECTED_FRESHNESS_ENV = {
  NPM_CONFIG_BEFORE: "",
  NPM_CONFIG_MIN_RELEASE_AGE: "",
  "NPM_CONFIG_MIN-RELEASE-AGE": "",
  npm_config_before: "",
  "npm_config_min-release-age": "",
  npm_config_min_release_age: "0",
};

function readNpmConfigList(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const raw = execFileSync("npm", ["config", "list", "--json"], {
    encoding: "utf-8",
    env: {
      ...process.env,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });
  return JSON.parse(raw) as Record<string, unknown>;
}

function expectUnsetNpmJsonConfig(value: unknown): void {
  expect(value == null).toBe(true);
}

function expectZeroNpmJsonConfig(value: unknown): void {
  expect(value === 0 || value === "0").toBe(true);
}

function expectUnsetOrZeroNpmJsonConfig(value: unknown): void {
  expect(value == null || value === false || value === 0 || value === "0").toBe(true);
}

describe("npm project install env", () => {
  it("uses an absolute POSIX script shell for npm lifecycle scripts", () => {
    withMockedPlatform("linux", () => {
      const existsSyncSpy = vi
        .spyOn(fsSync, "existsSync")
        .mockImplementation((candidate) => candidate === "/bin/sh");
      withRestoredMocks([existsSyncSpy], () => {
        expect(
          createNpmProjectInstallEnv(
            {
              PATH: "/tmp/openclaw-npm-global/bin",
            },
            {},
            FROZEN_NOW,
          ),
        ).toEqual({
          ...EXPECTED_FRESHNESS_ENV,
          NPM_CONFIG_SCRIPT_SHELL: "/bin/sh",
          PATH: "/tmp/openclaw-npm-global/bin",
          npm_config_dry_run: "false",
          npm_config_fetch_retries: "5",
          npm_config_fetch_retry_maxtimeout: "120000",
          npm_config_fetch_retry_mintimeout: "10000",
          npm_config_fetch_timeout: "300000",
          npm_config_global: "false",
          npm_config_location: "project",
          npm_config_package_lock: "false",
          npm_config_save: "false",
        });
      });
    });
  });

  it("preserves explicit npm script shell config", () => {
    withMockedPlatform("linux", () => {
      expect(
        createNpmProjectInstallEnv(
          {
            NPM_CONFIG_SCRIPT_SHELL: "/custom/sh",
          },
          {},
          FROZEN_NOW,
        ),
      ).toEqual({
        ...EXPECTED_FRESHNESS_ENV,
        NPM_CONFIG_SCRIPT_SHELL: "/custom/sh",
        npm_config_dry_run: "false",
        npm_config_fetch_retries: "5",
        npm_config_fetch_retry_maxtimeout: "120000",
        npm_config_fetch_retry_mintimeout: "10000",
        npm_config_fetch_timeout: "300000",
        npm_config_global: "false",
        npm_config_location: "project",
        npm_config_package_lock: "false",
        npm_config_save: "false",
      });
      expect(
        createNpmProjectInstallEnv(
          {
            npm_config_script_shell: "/custom/lower-sh",
          },
          {},
          FROZEN_NOW,
        ),
      ).toEqual({
        ...EXPECTED_FRESHNESS_ENV,
        npm_config_dry_run: "false",
        npm_config_fetch_retries: "5",
        npm_config_fetch_retry_maxtimeout: "120000",
        npm_config_fetch_retry_mintimeout: "10000",
        npm_config_fetch_timeout: "300000",
        npm_config_global: "false",
        npm_config_location: "project",
        npm_config_package_lock: "false",
        npm_config_save: "false",
        npm_config_script_shell: "/custom/lower-sh",
      });
    });
  });

  it("bypasses npm release-age filters for OpenClaw-managed installs", () => {
    const env = createNpmProjectInstallEnv(
      {
        NPM_CONFIG_BEFORE: "2026-01-01T00:00:00.000Z",
        NPM_CONFIG_MIN_RELEASE_AGE: "7",
        "npm_config_min-release-age": "7",
        npm_config_before: "2026-01-01T00:00:00.000Z",
        npm_config_min_release_age: "7",
      },
      {},
      FROZEN_NOW,
    );

    expect(env.NPM_CONFIG_BEFORE).toBe("");
    expect(env.npm_config_before).toBe("");
    expect(env.NPM_CONFIG_MIN_RELEASE_AGE).toBe("");
    expect(env["npm_config_min-release-age"]).toBe("");
    expect(env.npm_config_min_release_age).toBe("0");
  });

  it("does not leak parent npm freshness env into explicit child envs", () => {
    const previousBefore = process.env.NPM_CONFIG_BEFORE;
    process.env.NPM_CONFIG_BEFORE = "2026-01-01T00:00:00.000Z";
    try {
      const env = createNpmProjectInstallEnv({}, {}, FROZEN_NOW);

      expect(env.NPM_CONFIG_BEFORE).toBe("");
      expect(env.npm_config_before).toBe("");
      expect(env["npm_config_min-release-age"]).toBe("");
      expect(env.npm_config_min_release_age).toBe("0");
    } finally {
      if (previousBefore == null) {
        delete process.env.NPM_CONFIG_BEFORE;
      } else {
        process.env.NPM_CONFIG_BEFORE = previousBefore;
      }
    }
  });

  it("uses a current before override for explicit npm before policy", () => {
    const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "openclaw-npmrc-"));
    try {
      const npmrc = path.join(dir, "npmrc");
      fsSync.writeFileSync(npmrc, "before=2026-01-01T00:00:00.000Z\n", "utf-8");
      const env = createNpmProjectInstallEnv(
        {
          NPM_CONFIG_USERCONFIG: npmrc,
        },
        {},
        FROZEN_NOW,
      );

      expect(env["npm_config_min-release-age"]).toBe("");
      expect(env.npm_config_min_release_age).toBe("");
      expect(env.npm_config_before).toBe(FROZEN_NOW.toISOString());
      expect(env.npm_config_before).not.toBe("2026-01-01T00:00:00.000Z");

      const envWithParentAge = createNpmProjectInstallEnv(
        {
          NPM_CONFIG_USERCONFIG: npmrc,
          NPM_CONFIG_MIN_RELEASE_AGE: "7",
        },
        {},
        FROZEN_NOW,
      );
      expect(envWithParentAge.npm_config_min_release_age).toBe("");
      expect(envWithParentAge.npm_config_before).toBe(FROZEN_NOW.toISOString());
    } finally {
      fsSync.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses release-age args by default", () => {
    expect(createNpmFreshnessBypassArgs({}, FROZEN_NOW)).toEqual(["--min-release-age=0"]);
  });

  it("uses before args for stale npm before policies", () => {
    const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "openclaw-npmrc-"));
    try {
      const npmrc = path.join(dir, "npmrc");
      fsSync.writeFileSync(npmrc, "before=2026-01-01T00:00:00.000Z\n", "utf-8");

      expect(
        createNpmFreshnessBypassArgs(
          {
            NPM_CONFIG_USERCONFIG: npmrc,
          },
          FROZEN_NOW,
        ),
      ).toEqual([`--before=${FROZEN_NOW.toISOString()}`]);
    } finally {
      fsSync.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses before args for expanded npm userconfig paths", () => {
    const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "openclaw-home-npmrc-"));
    try {
      fsSync.writeFileSync(path.join(dir, ".npmrc"), "before=2026-01-01T00:00:00.000Z\n", "utf-8");

      expect(
        createNpmFreshnessBypassArgs(
          {
            HOME: dir,
            NPM_CONFIG_USERCONFIG: "~/.npmrc",
          },
          FROZEN_NOW,
        ),
      ).toEqual([`--before=${FROZEN_NOW.toISOString()}`]);
      expect(
        createNpmFreshnessBypassArgs(
          {
            HOME: dir,
            NPM_CONFIG_USERCONFIG: "${HOME}/.npmrc",
          },
          FROZEN_NOW,
        ),
      ).toEqual([`--before=${FROZEN_NOW.toISOString()}`]);
    } finally {
      fsSync.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses before args for npm default globalconfig before policies", () => {
    const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "openclaw-npm-prefix-"));
    try {
      const npmrcDir = path.join(dir, "etc");
      fsSync.mkdirSync(npmrcDir, { recursive: true });
      fsSync.writeFileSync(
        path.join(npmrcDir, "npmrc"),
        "before=2026-01-01T00:00:00.000Z\n",
        "utf-8",
      );

      expect(
        createNpmFreshnessBypassArgs(
          {
            NPM_CONFIG_PREFIX: dir,
          },
          FROZEN_NOW,
        ),
      ).toEqual([`--before=${FROZEN_NOW.toISOString()}`]);
    } finally {
      fsSync.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses before args for command project npmrc before policies", () => {
    const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "openclaw-project-npmrc-"));
    try {
      fsSync.writeFileSync(path.join(dir, ".npmrc"), "before=2026-01-01T00:00:00.000Z\n", "utf-8");

      expect(createNpmFreshnessBypassArgs({}, FROZEN_NOW, { npmConfigCwd: dir })).toEqual([
        `--before=${FROZEN_NOW.toISOString()}`,
      ]);

      const env = createNpmProjectInstallEnv({}, { npmConfigCwd: dir }, FROZEN_NOW);
      expect(env.npm_config_min_release_age).toBe("");
      expect(env.npm_config_before).toBe(FROZEN_NOW.toISOString());
    } finally {
      fsSync.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses before args for the current project npmrc by default", () => {
    const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "openclaw-current-npmrc-"));
    try {
      fsSync.writeFileSync(path.join(dir, ".npmrc"), "before=2026-01-01T00:00:00.000Z\n", "utf-8");
      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
      withRestoredMocks([cwdSpy], () => {
        expect(createNpmFreshnessBypassArgs({}, FROZEN_NOW)).toEqual([
          `--before=${FROZEN_NOW.toISOString()}`,
        ]);
      });
    } finally {
      fsSync.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses before args for scoped npm prefix before policies", () => {
    const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "openclaw-prefix-npmrc-"));
    try {
      const npmrcDir = path.join(dir, "etc");
      fsSync.mkdirSync(npmrcDir, { recursive: true });
      fsSync.writeFileSync(
        path.join(npmrcDir, "npmrc"),
        "before=2026-01-01T00:00:00.000Z\n",
        "utf-8",
      );

      expect(createNpmFreshnessBypassArgs({}, FROZEN_NOW, { npmConfigPrefix: dir })).toEqual([
        `--before=${FROZEN_NOW.toISOString()}`,
      ]);
    } finally {
      fsSync.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("overrides stale npmrc before config without emitting release-age config", () => {
    const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "openclaw-npmrc-"));
    try {
      const npmrc = path.join(dir, "npmrc");
      fsSync.writeFileSync(npmrc, "before=2026-01-01T00:00:00.000Z\n", "utf-8");
      const env = createNpmProjectInstallEnv(
        {
          NPM_CONFIG_USERCONFIG: npmrc,
        },
        {},
        FROZEN_NOW,
      );

      const npmConfig = readNpmConfigList(env);
      expect(npmConfig.before).toBe(FROZEN_NOW.toISOString());
      expectUnsetNpmJsonConfig(npmConfig["min-release-age"]);
    } finally {
      fsSync.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses release-age args for npmrc release-age policies", () => {
    const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "openclaw-npmrc-"));
    try {
      const npmrc = path.join(dir, "npmrc");
      fsSync.writeFileSync(npmrc, "min-release-age=7\n", "utf-8");

      expect(
        createNpmFreshnessBypassArgs(
          {
            NPM_CONFIG_USERCONFIG: npmrc,
          },
          FROZEN_NOW,
        ),
      ).toEqual(["--min-release-age=0"]);
    } finally {
      fsSync.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("overrides npmrc release-age config without emitting before config", () => {
    const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "openclaw-npmrc-"));
    try {
      const npmrc = path.join(dir, "npmrc");
      fsSync.writeFileSync(npmrc, "min-release-age=7\n", "utf-8");
      const env = createNpmProjectInstallEnv(
        {
          NPM_CONFIG_USERCONFIG: npmrc,
        },
        {},
        FROZEN_NOW,
      );

      expect(env.npm_config_before).toBe("");
      expect(env.npm_config_min_release_age).toBe("0");
      const npmConfig = readNpmConfigList(env);
      expect(
        npmConfig.before == null ||
          npmConfig.before === false ||
          typeof npmConfig.before === "string",
      ).toBe(true);
      expectUnsetOrZeroNpmJsonConfig(npmConfig["min-release-age"]);
    } finally {
      fsSync.rmSync(dir, { recursive: true, force: true });
    }
  });
});
