import { describe, expect, it } from "vitest";
import { createSafeNpmInstallArgs, createSafeNpmInstallEnv } from "./safe-package-install.js";

describe("safe npm install helpers", () => {
  it("builds script-free npm install args", () => {
    expect(
      createSafeNpmInstallArgs({
        omitDev: true,
        omitPeer: true,
        legacyPeerDeps: true,
        ignoreWorkspaces: true,
        loglevel: "error",
        noAudit: true,
        noFund: true,
      }),
    ).toEqual([
      "install",
      "--omit=dev",
      "--omit=peer",
      "--legacy-peer-deps",
      "--loglevel=error",
      "--ignore-scripts",
      "--workspaces=false",
      "--no-audit",
      "--no-fund",
    ]);
  });

  it("forces project-local script-free npm install env", () => {
    const env = createSafeNpmInstallEnv(
      {
        PATH: "/usr/bin:/bin",
        NPM_CONFIG_IGNORE_SCRIPTS: "false",
        NPM_CONFIG_LEGACY_PEER_DEPS: "false",
        NPM_CONFIG_STRICT_PEER_DEPS: "true",
        npm_config_global: "true",
        npm_config_include_workspace_root: "true",
        npm_config_ignore_scripts: "false",
        npm_config_location: "global",
        npm_config_package_lock: "true",
        npm_config_workspace: "extensions/telegram",
        npm_config_workspaces: "true",
      },
      {
        cacheDir: "/tmp/openclaw-npm-cache",
        ignoreWorkspaces: true,
        legacyPeerDeps: true,
        packageLock: false,
        quiet: true,
      },
    );

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.COREPACK_ENABLE_DOWNLOAD_PROMPT).toBe("0");
    expect(env.NPM_CONFIG_IGNORE_SCRIPTS).toBe("true");
    expect(env.npm_config_audit).toBe("false");
    expect(env.npm_config_cache).toBe("/tmp/openclaw-npm-cache");
    expect(env.npm_config_dry_run).toBe("false");
    expect(env.npm_config_fetch_retries).toBe("5");
    expect(env.npm_config_fetch_retry_maxtimeout).toBe("120000");
    expect(env.npm_config_fetch_retry_mintimeout).toBe("10000");
    expect(env.npm_config_fetch_timeout).toBe("300000");
    expect(env.npm_config_fund).toBe("false");
    expect(env.npm_config_global).toBe("false");
    expect(env.npm_config_ignore_scripts).toBe("true");
    expect(env.npm_config_legacy_peer_deps).toBe("true");
    expect(env.npm_config_location).toBe("project");
    expect(env.npm_config_loglevel).toBe("error");
    expect(env.npm_config_package_lock).toBe("false");
    expect(env.npm_config_progress).toBe("false");
    expect(env.npm_config_save).toBe("false");
    expect(env.npm_config_strict_peer_deps).toBe("false");
    expect(env.npm_config_workspaces).toBe("false");
    expect(env.npm_config_yes).toBe("true");
    expect(env.npm_config_include_workspace_root).toBeUndefined();
    expect(env.npm_config_workspace).toBeUndefined();
  });

  it("does not inherit host legacy peer dependency mode by default", () => {
    const env = createSafeNpmInstallEnv({
      PATH: "/usr/bin:/bin",
      npm_config_legacy_peer_deps: "true",
      npm_config_strict_peer_deps: "true",
    });

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.npm_config_legacy_peer_deps).toBe("false");
    expect(env.npm_config_strict_peer_deps).toBe("false");
  });

  it("allows package-lock-enabled installs to write lockfiles", () => {
    const env = createSafeNpmInstallEnv(
      {
        PATH: "/usr/bin:/bin",
        npm_config_save: "false",
      },
      {
        packageLock: true,
      },
    );

    expect(env.npm_config_package_lock).toBe("true");
    expect(env.npm_config_save).toBe("true");
  });
});
