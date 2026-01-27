import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const copyToClipboard = vi.fn();
const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

vi.mock("../infra/clipboard.js", () => ({
  copyToClipboard,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: runtime,
}));

describe("browser extension install", () => {
  it("installs into the state dir (never node_modules)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "moltbot-ext-"));
    const { installChromeExtension } = await import("./browser-cli-extension.js");

    const sourceDir = path.resolve(process.cwd(), "assets/chrome-extension");
    const result = await installChromeExtension({ stateDir: tmp, sourceDir });

    expect(result.path).toBe(path.join(tmp, "browser", "chrome-extension"));
    expect(fs.existsSync(path.join(result.path, "manifest.json"))).toBe(true);
    expect(result.path.includes("node_modules")).toBe(false);
  });

  it("copies extension path to clipboard", async () => {
    const prev = process.env.CLAWDBOT_STATE_DIR;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "moltbot-ext-path-"));
    process.env.CLAWDBOT_STATE_DIR = tmp;

    try {
      copyToClipboard.mockReset();
      copyToClipboard.mockResolvedValue(true);
      runtime.log.mockReset();
      runtime.error.mockReset();
      runtime.exit.mockReset();

      const dir = path.join(tmp, "browser", "chrome-extension");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ manifest_version: 3 }));

      vi.resetModules();
      const { Command } = await import("commander");
      const { registerBrowserExtensionCommands } = await import("./browser-cli-extension.js");

      const program = new Command();
      const browser = program.command("browser").option("--json", false);
      registerBrowserExtensionCommands(
        browser,
        (cmd) => cmd.parent?.opts?.() as { json?: boolean },
      );

      await program.parseAsync(["browser", "extension", "path"], { from: "user" });

      expect(copyToClipboard).toHaveBeenCalledWith(dir);
    } finally {
      if (prev === undefined) delete process.env.CLAWDBOT_STATE_DIR;
      else process.env.CLAWDBOT_STATE_DIR = prev;
    }
  });
});
