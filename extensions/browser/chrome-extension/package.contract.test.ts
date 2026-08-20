import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const extensionDir = path.dirname(fileURLToPath(import.meta.url));

describe("simplified Chrome extension package", () => {
  it("declares only relay, access, storage, watchdog, and native bootstrap permissions", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));

    expect(manifest.permissions).toEqual([
      "debugger",
      "tabs",
      "tabGroups",
      "storage",
      "alarms",
      "nativeMessaging",
    ]);
    expect(manifest).not.toHaveProperty("commands");
    expect(manifest.options_ui).toEqual({ page: "options.html", open_in_tab: true });
  });

  it("contains no copilot, page-share, or side-panel runtime", () => {
    const files = fs
      .readdirSync(extensionDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(entry.parentPath, entry.name).slice(extensionDir.length + 1))
      .filter((entry) => !entry.endsWith(".test.ts"));

    expect(files.join("\n")).not.toMatch(/copilot|page-share|sidepanel/iu);
  });

  it("ships redacted retired-custody recovery guidance", () => {
    const options = fs.readFileSync(path.join(extensionDir, "options.html"), "utf8");
    const popup = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");

    expect(options).toContain("Automation is paused to protect a pre-upgrade copilot session.");
    expect(options).toContain("Confirm old runs are finished");
    expect(options).toContain("Disconnect and disable automatic setup");
    expect(options).toContain("Use local OpenClaw");
    expect(popup).toContain("Automation paused; open Settings");
    expect(options).not.toMatch(/copilotSessionRegistryV1|sessionId|sessionKey|deviceToken/u);
  });
});
