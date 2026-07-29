// Discord tests cover setup entry plugin behavior.
import { describe, expect, it } from "vitest";
import setupEntry from "./setup-entry.js";

type LegacyStateMigrationsApi = typeof import("./legacy-state-migrations-api.js");

const migrationDetector =
  (() => []) satisfies LegacyStateMigrationsApi["detectDiscordLegacyStateMigrations"];
const setupEntryLoadOptions = {
  createLoaderForTest: (() => (specifier: string) => {
    expect(specifier).toMatch(/[\\/]legacy-state-migrations-api\.[jt]s$/u);
    return {
      detectDiscordLegacyStateMigrations: migrationDetector,
    } satisfies Pick<LegacyStateMigrationsApi, "detectDiscordLegacyStateMigrations">;
  }) as never,
};

describe("discord setup entry", () => {
  it("resolves the legacy state migration detector through the setup entry", () => {
    expect(setupEntry.kind).toBe("bundled-channel-setup-entry");
    expect(setupEntry.features).toEqual({ legacyStateMigrations: true });
    expect(setupEntry.loadLegacyStateMigrationDetector?.(setupEntryLoadOptions)).toBe(
      migrationDetector,
    );
  });
});
