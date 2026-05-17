import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withMockedPlatform, withRestoredMocks } from "../test-utils/vitest-spies.js";
import { createNpmProjectInstallEnv } from "./npm-install-env.js";

const EXPECTED_MIN_FRESHNESS_ENV = {
  NPM_CONFIG_BEFORE: "",
  NPM_CONFIG_MIN_RELEASE_AGE: "",
  "NPM_CONFIG_MIN-RELEASE-AGE": "",
  npm_config_before: "",
  "npm_config_min-release-age": "0",
  npm_config_min_release_age: "",
};

describe("npm project install env", () => {
  it("uses an absolute POSIX script shell for npm lifecycle scripts", () => {
    withMockedPlatform("linux", () => {
      const existsSyncSpy = vi
        .spyOn(fsSync, "existsSync")
        .mockImplementation((candidate) => candidate === "/bin/sh");
      withRestoredMocks([existsSyncSpy], () => {
        expect(
          createNpmProjectInstallEnv({
            PATH: "/tmp/openclaw-npm-global/bin",
          }),
        ).toEqual({
          ...EXPECTED_MIN_FRESHNESS_ENV,
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
        createNpmProjectInstallEnv({
          NPM_CONFIG_SCRIPT_SHELL: "/custom/sh",
        }),
      ).toEqual({
        ...EXPECTED_MIN_FRESHNESS_ENV,
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
        createNpmProjectInstallEnv({
          npm_config_script_shell: "/custom/lower-sh",
        }),
      ).toEqual({
        ...EXPECTED_MIN_FRESHNESS_ENV,
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
    const env = createNpmProjectInstallEnv({
      NPM_CONFIG_BEFORE: "2026-01-01T00:00:00.000Z",
      NPM_CONFIG_MIN_RELEASE_AGE: "7",
      "npm_config_min-release-age": "7",
      npm_config_before: "2026-01-01T00:00:00.000Z",
      npm_config_min_release_age: "7",
    });

    expect(env.NPM_CONFIG_BEFORE).toBe("");
    expect(env.npm_config_before).toBe("");
    expect(env.NPM_CONFIG_MIN_RELEASE_AGE).toBe("");
    expect(env["npm_config_min-release-age"]).toBe("0");
    expect(env.npm_config_min_release_age).toBe("");
  });

  it("does not leak parent npm freshness env into explicit child envs", () => {
    const previousBefore = process.env.NPM_CONFIG_BEFORE;
    process.env.NPM_CONFIG_BEFORE = "2026-01-01T00:00:00.000Z";
    try {
      const env = createNpmProjectInstallEnv({});

      expect(env.NPM_CONFIG_BEFORE).toBe("");
      expect(env.npm_config_before).toBe("");
      expect(env["npm_config_min-release-age"]).toBe("0");
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
      const env = createNpmProjectInstallEnv({
        NPM_CONFIG_USERCONFIG: npmrc,
      });

      expect(env["npm_config_min-release-age"]).toBe("");
      expect(env.npm_config_before).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(env.npm_config_before).not.toBe("2026-01-01T00:00:00.000Z");
    } finally {
      fsSync.rmSync(dir, { recursive: true, force: true });
    }
  });
});
