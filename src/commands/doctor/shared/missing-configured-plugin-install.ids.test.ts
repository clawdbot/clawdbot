import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { initializeNativeSessionCatalogPreferences } from "../../../plugins/native-session-catalog-config.js";
import { collectConfiguredPluginIds } from "./missing-configured-plugin-install.ids.js";

describe("Doctor plugin installation intent", () => {
  it("does not install plugins merely to persist fresh native conversation opt-outs", () => {
    const cfg = initializeNativeSessionCatalogPreferences({});
    expect(collectConfiguredPluginIds(cfg, {})).toEqual(new Set());
  });

  it.each([
    { name: "explicit enablement", entry: { enabled: true } },
    { name: "additional plugin settings", entry: { config: { extra: true } } },
    {
      name: "conversation discovery opt-in",
      entry: { config: { sessionCatalog: { enabled: true } } },
    },
  ])("preserves $name as installation intent", ({ entry }) => {
    const cfg = initializeNativeSessionCatalogPreferences({
      plugins: { entries: { codex: entry } },
    });
    expect(collectConfiguredPluginIds(cfg, {})).toEqual(new Set(["codex"]));
  });

  it("retains a selected runtime even when its native conversations are disabled", () => {
    const cfg: OpenClawConfig = initializeNativeSessionCatalogPreferences({
      agents: { defaults: { models: { "example/starter": { agentRuntime: { id: "codex" } } } } },
    });
    expect(collectConfiguredPluginIds(cfg, {}).has("codex")).toBe(true);
  });

  it("does not treat an undeclared plugin setting as a host-generated opt-out", () => {
    const cfg = initializeNativeSessionCatalogPreferences({
      plugins: { entries: { unrelated: { config: { sessionCatalog: { enabled: false } } } } },
    });
    expect(collectConfiguredPluginIds(cfg, {})).toEqual(new Set(["unrelated"]));
  });
});
