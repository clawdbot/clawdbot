import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { clearRetiredExtensionState } from "./modules/native-bootstrap.js";

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

  it("clears only retired copilot keys", async () => {
    const localRemove = vi.fn(async () => undefined);
    const sessionRemove = vi.fn(async () => undefined);
    await clearRetiredExtensionState({
      storage: {
        local: { remove: localRemove },
        session: { remove: sessionRemove },
      },
    });

    expect(localRemove).toHaveBeenCalledWith([
      "copilotSessionRegistryV1",
      "copilotDeviceIdentitiesV1",
      "copilotDeviceTokensV1",
    ]);
    expect(sessionRemove).toHaveBeenCalledWith([
      "copilotBrowserInstanceV1",
      "copilotPanelBindingsV1",
    ]);
    const removed = [...localRemove.mock.calls.flat(), ...sessionRemove.mock.calls.flat()].flat();
    expect(removed).not.toEqual(
      expect.arrayContaining([
        "relayUrl",
        "token",
        "accessMode",
        "deniedTabIdsV1",
        "nativeBootstrapDisabled",
      ]),
    );
  });
});
