import { describe, expect, it, vi } from "vitest";

vi.mock("baileys", () => {
  throw new Error("setup plugin load must not load Baileys");
});

vi.mock("./src/setup-finalize.js", () => {
  throw new Error("setup status load must not load finalize");
});

describe("whatsapp setup entry", () => {
  it("loads the setup plugin without installing or importing runtime dependencies", async () => {
    const { default: setupEntry } = await import("./setup-entry.js");

    expect(setupEntry.kind).toBe("bundled-channel-setup-entry");
    expect(setupEntry.features).toEqual({
      legacySessionSurfaces: true,
      legacyStateMigrations: true,
    });

    const whatsappSetupPlugin = setupEntry.loadSetupPlugin();
    expect(whatsappSetupPlugin.id).toBe("whatsapp");
    const detectLegacyStateMigrations = setupEntry.loadLegacyStateMigrationDetector?.();
    if (!detectLegacyStateMigrations) {
      throw new Error("expected WhatsApp legacy state migration detector");
    }
    expect(
      detectLegacyStateMigrations({
        cfg: {},
        env: {},
        oauthDir: "/tmp/openclaw-whatsapp-empty",
        stateDir: "/tmp/openclaw-state",
      }),
    ).toStrictEqual([]);
    const legacySessionSurface = setupEntry.loadLegacySessionSurface?.();
    if (!legacySessionSurface) {
      throw new Error("expected WhatsApp legacy session surface");
    }
    expect(Object.keys(legacySessionSurface).toSorted()).toEqual([
      "canonicalizeLegacySessionKey",
      "isLegacyGroupSessionKey",
    ]);
    expect(legacySessionSurface.canonicalizeLegacySessionKey).toBeTypeOf("function");
    expect(legacySessionSurface.isLegacyGroupSessionKey).toBeTypeOf("function");
  });

  it("loads the delegated setup wizard without importing runtime dependencies", async () => {
    const { whatsappSetupWizard } = await import("./src/setup-surface.js");

    expect(whatsappSetupWizard.channel).toBe("whatsapp");
  });
});
