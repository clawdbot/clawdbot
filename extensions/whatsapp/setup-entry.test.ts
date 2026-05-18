import { describe, expect, it, vi } from "vitest";
import * as legacySessionSurfaceApi from "./legacy-session-surface-api.js";
import * as legacyStateMigrationsApi from "./legacy-state-migrations-api.js";
import setupEntry from "./setup-entry.js";
import * as setupPluginApi from "./setup-plugin-api.js";

vi.mock("baileys", () => {
  throw new Error("setup plugin load must not load Baileys");
});

vi.mock("./src/setup-finalize.js", () => {
  throw new Error("setup status load must not load finalize");
});

const setupEntryLoadOptions = {
  createLoaderForTest: (() => (specifier: string) => {
    if (/[\\/]setup-plugin-api\.[jt]s$/u.test(specifier)) {
      return setupPluginApi;
    }
    if (/[\\/]legacy-state-migrations-api\.[jt]s$/u.test(specifier)) {
      return legacyStateMigrationsApi;
    }
    if (/[\\/]legacy-session-surface-api\.[jt]s$/u.test(specifier)) {
      return legacySessionSurfaceApi;
    }
    throw new Error(`unexpected setup entry module load: ${specifier}`);
  }) as never,
};

describe("whatsapp setup entry", () => {
  it("loads setup entry metadata without importing runtime dependencies", () => {
    expect(setupEntry.kind).toBe("bundled-channel-setup-entry");
    expect(setupEntry.features).toEqual({
      legacySessionSurfaces: true,
      legacyStateMigrations: true,
    });
  });

  it("loads the setup plugin without installing runtime dependencies", () => {
    const whatsappSetupPlugin = setupEntry.loadSetupPlugin(setupEntryLoadOptions);
    expect(whatsappSetupPlugin.id).toBe("whatsapp");
  });

  it("loads legacy setup helpers without importing runtime dependencies", () => {
    const detectLegacyStateMigrations =
      setupEntry.loadLegacyStateMigrationDetector?.(setupEntryLoadOptions);
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
    const legacySessionSurface = setupEntry.loadLegacySessionSurface?.(setupEntryLoadOptions);
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
