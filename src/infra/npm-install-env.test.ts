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
      ).toMatchObject({
        NPM_CONFIG_SCRIPT_SHELL: "/bin/sh",
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
      ).toMatchObject({
        NPM_CONFIG_SCRIPT_SHELL: "/custom/sh",
      });
      expect(
        createNpmProjectInstallEnv({
          npm_config_script_shell: "/custom/lower-sh",
        }),
      ).toMatchObject({
        npm_config_script_shell: "/custom/lower-sh",
      });
    } finally {
      platformSpy.mockRestore();
    }
  });
});
