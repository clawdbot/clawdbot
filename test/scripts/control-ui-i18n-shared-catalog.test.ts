import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashControlUiTranslationText } from "../../scripts/lib/control-ui-i18n-catalog.ts";
import {
  buildControlUiSharedLocaleBundle,
  loadControlUiSharedCatalog,
  resolveControlUiSharedTranslation,
  type ControlUiSharedCatalog,
} from "../../scripts/lib/control-ui-i18n-shared-catalog.ts";
import type {
  TranslationMap,
  TranslationMemoryEntry,
} from "../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function memoryEntry(
  semanticKey: string,
  source: string,
  translated: string,
  overrides: Partial<TranslationMemoryEntry> = {},
): TranslationMemoryEntry {
  return {
    cache_key: `cache:${semanticKey}`,
    model: "test-model",
    provider: "test-provider",
    segment_id: semanticKey,
    source_path: "ui/src/i18n/locales/fr.ts",
    src_lang: "en",
    text: source,
    text_hash: hashControlUiTranslationText(source),
    tgt_lang: "fr",
    translated,
    updated_at: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

function writeCatalogFixture(
  source: TranslationMap,
  memories: Readonly<Record<string, readonly TranslationMemoryEntry[]>> = {},
  desktopMessages?: Readonly<Record<string, { defaultMessage: string; description: string }>>,
): string {
  const rootDir = tempDirs.make("openclaw-shared-i18n-");
  const localeDir = path.join(rootDir, "ui", "src", "i18n", "locales");
  const memoryDir = path.join(rootDir, "ui", "src", "i18n", ".i18n");
  mkdirSync(localeDir, { recursive: true });
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(path.join(localeDir, "en.ts"), `export const en = ${JSON.stringify(source)};\n`);
  for (const [locale, entries] of Object.entries(memories)) {
    writeFileSync(
      path.join(memoryDir, `${locale}.tm.jsonl`),
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
  }
  if (desktopMessages) {
    const desktopDir = path.join(rootDir, "apps", "linux", "ui");
    mkdirSync(desktopDir, { recursive: true });
    writeFileSync(path.join(desktopDir, "messages.json"), `${JSON.stringify(desktopMessages)}\n`);
  }
  return rootDir;
}

describe("shared Control UI localization catalog", () => {
  it("indexes stable semantic keys and existing source-hash-valid locale memory", async () => {
    const rootDir = writeCatalogFixture(
      {
        shell: { title: "Open", status: "Open" },
        common: { greeting: "Hello {name}", cancel: "Cancel" },
      },
      {
        fr: [
          memoryEntry("shell.status", "Open", "Ouvrir", {
            segment_ids: ["shell.title", "retired.open"],
          }),
          memoryEntry("common.cancel", "Cancel", "Annuler"),
          memoryEntry("common.greeting", "Previous greeting", "Ancienne salutation"),
        ],
      },
    );

    const catalog = await loadControlUiSharedCatalog({
      rootDir,
      locales: ["sv", "fr"],
    });

    expect([...catalog.source.entries()]).toEqual([
      ["common.cancel", "Cancel"],
      ["common.greeting", "Hello {name}"],
      ["shell.status", "Open"],
      ["shell.title", "Open"],
    ]);
    expect(catalog.source.get("shell.status")).toBe("Open");
    expect(catalog.source.get("shell.title")).toBe("Open");
    expect([...catalog.translations.keys()]).toEqual(["fr"]);
    expect([...catalog.translations.get("fr")!.entries()]).toEqual([
      ["common.cancel", "Annuler"],
      ["shell.status", "Ouvrir"],
      ["shell.title", "Ouvrir"],
    ]);
    expect(catalog.translations.get("fr")!.has("common.greeting")).toBe(false);
    expect(catalog.translations.get("sv")).toBeUndefined();
  });

  it("merges desktop-owned messages without treating matching English as semantic identity", async () => {
    const rootDir = writeCatalogFixture(
      { common: { cancel: "Cancel", save: "Save" } },
      { fr: [memoryEntry("common.cancel", "Cancel", "Annuler")] },
      {
        "desktop.actions.cancel": {
          defaultMessage: "Cancel",
          description: "Dismiss the Linux desktop companion action",
        },
        "desktop.gateway.connecting": {
          defaultMessage: "Connecting to Gateway",
          description: "Status shown while the desktop app discovers its Gateway",
        },
      },
    );

    const catalog = await loadControlUiSharedCatalog({ rootDir, locales: ["fr"] });

    expect(catalog.source.get("desktop.gateway.connecting")).toBe("Connecting to Gateway");
    expect(catalog.descriptions.get("desktop.gateway.connecting")).toBe(
      "Status shown while the desktop app discovers its Gateway",
    );
    expect(catalog.source.get("common.cancel")).toBe("Cancel");
    expect(catalog.source.get("desktop.actions.cancel")).toBe("Cancel");
    expect(catalog.translations.get("fr")?.get("common.cancel")).toBe("Annuler");
    expect(resolveControlUiSharedTranslation(catalog, "fr", "common.cancel")).toBe("Annuler");
    expect(
      resolveControlUiSharedTranslation(catalog, "fr", "desktop.actions.cancel"),
    ).toBeUndefined();
    expect(
      resolveControlUiSharedTranslation(catalog, "fr", "desktop.gateway.connecting"),
    ).toBeUndefined();
    expect(buildControlUiSharedLocaleBundle(catalog, { prefixes: ["desktop"] })).toEqual({
      en: {
        "desktop.actions.cancel": "Cancel",
        "desktop.gateway.connecting": "Connecting to Gateway",
      },
      fr: {},
    });
  });

  it("never borrows translations when the same English text has different semantic meanings", async () => {
    const rootDir = writeCatalogFixture(
      { action: { open: "Open" }, status: { open: "Open" } },
      {
        fr: [
          memoryEntry("action.open", "Open", "Ouvrir"),
          memoryEntry("status.open", "Open", "Ouvert"),
        ],
      },
      {
        "desktop.gateway.open": {
          defaultMessage: "Open",
          description: "Current state of the discovered Gateway",
        },
      },
    );

    const catalog = await loadControlUiSharedCatalog({ rootDir, locales: ["fr"] });

    expect(catalog.source.get("action.open")).toBe("Open");
    expect(catalog.source.get("status.open")).toBe("Open");
    expect(resolveControlUiSharedTranslation(catalog, "fr", "action.open")).toBe("Ouvrir");
    expect(resolveControlUiSharedTranslation(catalog, "fr", "status.open")).toBe("Ouvert");
    expect(
      resolveControlUiSharedTranslation(catalog, "fr", "desktop.gateway.open"),
    ).toBeUndefined();
    expect(buildControlUiSharedLocaleBundle(catalog, { prefixes: ["desktop"] })).toEqual({
      en: { "desktop.gateway.open": "Open" },
      fr: {},
    });
  });

  it("selects semantic IDs, source text, and key namespaces without recording fake fallbacks", () => {
    const catalog: ControlUiSharedCatalog = {
      source: new Map([
        ["shell.window.title", "OpenClaw"],
        ["common.cancel", "Cancel"],
        ["shell.window.description", "Connect to Gateway"],
        ["common.save", "Save"],
        ["status.pending", "Waiting"],
      ]),
      translations: new Map([
        [
          "fr",
          new Map([
            ["common.cancel", "Annuler"],
            ["common.save", "Enregistrer"],
            ["shell.window.title", "OpenClaw"],
          ]),
        ],
        ["de", new Map([["common.cancel", "Abbrechen"]])],
      ]),
      descriptions: new Map(),
    };

    expect(
      buildControlUiSharedLocaleBundle(catalog, {
        keys: ["common.cancel"],
        prefixes: ["shell.window."],
        sources: ["Save"],
      }),
    ).toEqual({
      en: {
        "common.cancel": "Cancel",
        "common.save": "Save",
        "shell.window.description": "Connect to Gateway",
        "shell.window.title": "OpenClaw",
      },
      de: { "common.cancel": "Abbrechen" },
      fr: {
        "common.cancel": "Annuler",
        "common.save": "Enregistrer",
        "shell.window.title": "OpenClaw",
      },
    });
  });

  it("keeps an explicit empty selection empty", () => {
    const catalog: ControlUiSharedCatalog = {
      source: new Map([["common.cancel", "Cancel"]]),
      translations: new Map([["fr", new Map([["common.cancel", "Annuler"]])]]),
      descriptions: new Map(),
    };

    expect(buildControlUiSharedLocaleBundle(catalog, { keys: [] })).toEqual({ en: {}, fr: {} });
  });

  it("fails clearly when the English source does not expose its canonical export", async () => {
    const rootDir = writeCatalogFixture({ common: { cancel: "Cancel" } });
    writeFileSync(
      path.join(rootDir, "ui", "src", "i18n", "locales", "en.ts"),
      "export const unexpected = {};\n",
    );

    await expect(loadControlUiSharedCatalog({ rootDir, locales: [] })).rejects.toThrow(
      "does not export an English localization catalog",
    );
  });

  it("rejects a desktop semantic key that would silently replace a web message", async () => {
    const rootDir = writeCatalogFixture(
      { common: { cancel: "Cancel" } },
      {},
      {
        "common.cancel": {
          defaultMessage: "Never mind",
          description: "Conflicting desktop action",
        },
      },
    );

    await expect(loadControlUiSharedCatalog({ rootDir, locales: [] })).rejects.toThrow(
      "conflicts with the Control UI catalog",
    );
  });
});
