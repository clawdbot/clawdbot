import fsSync from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createNpmProjectInstallEnv } from "./npm-install-env.js";

describe("npm project install env", () => {
  it("uses an absolute POSIX script shell for npm lifecycle scripts", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const existsSyncSpy = vi
      .spyOn(fsSync, "existsSync")
      .mockImplementation((candidate) => candidate === "/bin/sh");
    try {
      expect(
        createNpmProjectInstallEnv({
          PATH: "/tmp/openclaw-npm-global/bin",
        }),
      ).toEqual({
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
    } finally {
      existsSyncSpy.mockRestore();
      platformSpy.mockRestore();
    }
  });

  it("preserves explicit npm script shell config", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    try {
      expect(
        createNpmProjectInstallEnv({
          NPM_CONFIG_SCRIPT_SHELL: "/custom/sh",
        }),
      ).toEqual({
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
    } finally {
      platformSpy.mockRestore();
    }
  });
});
