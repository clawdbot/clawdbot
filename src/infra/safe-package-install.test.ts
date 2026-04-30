import { describe, expect, it } from "vitest";
import { createSafeNpmInstallArgs, createSafeNpmInstallEnv } from "./safe-package-install.js";

describe("safe npm install helpers", () => {
  it("builds script-free npm install args", () => {
    expect(
      createSafeNpmInstallArgs({
        omitDev: true,
        loglevel: "error",
        noAudit: true,
        noFund: true,
      }),
    ).toEqual([
      "install",
      "--omit=dev",
      "--loglevel=error",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
  });

  it("forces project-local script-free npm install env", () => {
    expect(
      createSafeNpmInstallEnv(
        {
          PATH: "/usr/bin:/bin",
          npm_config_global: "true",
          npm_config_location: "global",
          npm_config_package_lock: "true",
        },
        {
          cacheDir: "/tmp/openclaw-npm-cache",
          legacyPeerDeps: true,
          packageLock: false,
          quiet: true,
        },
      ),
    ).toEqual({
      PATH: "/usr/bin:/bin",
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
      npm_config_audit: "false",
      npm_config_cache: "/tmp/openclaw-npm-cache",
      npm_config_dry_run: "false",
      npm_config_fetch_retries: "5",
      npm_config_fetch_retry_maxtimeout: "120000",
      npm_config_fetch_retry_mintimeout: "10000",
      npm_config_fetch_timeout: "300000",
      npm_config_fund: "false",
      npm_config_global: "false",
      npm_config_legacy_peer_deps: "true",
      npm_config_location: "project",
      npm_config_loglevel: "error",
      npm_config_package_lock: "false",
      npm_config_progress: "false",
      npm_config_save: "false",
      npm_config_yes: "true",
    });
  });
});
