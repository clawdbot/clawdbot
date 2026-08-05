import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNativeGeneratedArtifactsIsolated,
  detectChangedScope,
  NativeGeneratedArtifactsMixedError,
  shouldRunNativeI18n,
} from "../../scripts/ci-changed-scope.mjs";
import {
  normalizeNativeI18nInventory,
  planNativeI18nRefresh,
} from "../../scripts/lib/native-i18n-refresh-plan.mjs";

const tempDirectories: string[] = [];
const inventoryPath = "apps/.i18n/native-source.json";
const linuxMessagesPath = "apps/linux/ui/messages.json";
const memoryPath = "ui/src/i18n/.i18n/de.tm.jsonl";
const englishPath = "ui/src/i18n/locales/en.ts";
const defaultInventory = {
  version: 1,
  entries: [
    {
      id: "native.apple.cancel",
      semanticKey: "common.cancel",
      source: "Cancel",
      description: "Dismiss the current dialog.",
      line: 41,
      path: "apps/macos/Sources/OpenClaw/Settings.swift",
      surface: "apple",
    },
  ],
};
const defaultLinuxMessages = {
  "desktop.welcome": {
    defaultMessage: "Welcome aboard",
    description: "Greeting on the desktop home screen.",
  },
};

type FixtureOptions = {
  previousInventory?: object;
  currentInventory?: object;
  previousLinuxMessages?: object;
  currentLinuxMessages?: object;
  previousFiles?: Record<string, string>;
  currentFiles?: Record<string, string>;
};

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeFixtureFile(cwd: string, filePath: string, contents: string): void {
  const destination = path.join(cwd, filePath);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, contents, "utf8");
}

function commitFixture(cwd: string, message: string): string {
  git(cwd, ["add", "."]);
  git(cwd, [
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=Native locale fixture",
    "-c",
    "user.email=native-locale@example.invalid",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    message,
  ]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

function createFixture(options: FixtureOptions = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), "openclaw-native-i18n-plan-"));
  tempDirectories.push(cwd);
  git(cwd, ["init", "--quiet", "-b", "main"]);
  const previousInventory = options.previousInventory ?? defaultInventory;
  const previousLinuxMessages = options.previousLinuxMessages ?? defaultLinuxMessages;
  writeFixtureFile(cwd, inventoryPath, `${JSON.stringify(previousInventory, null, 2)}\n`);
  writeFixtureFile(cwd, linuxMessagesPath, `${JSON.stringify(previousLinuxMessages, null, 2)}\n`);
  for (const [filePath, contents] of Object.entries(options.previousFiles ?? {})) {
    writeFixtureFile(cwd, filePath, contents);
  }
  const beforeSha = commitFixture(cwd, "baseline");

  writeFixtureFile(
    cwd,
    inventoryPath,
    `${JSON.stringify(options.currentInventory ?? previousInventory, null, 2)}\n`,
  );
  writeFixtureFile(
    cwd,
    linuxMessagesPath,
    `${JSON.stringify(options.currentLinuxMessages ?? previousLinuxMessages, null, 2)}\n`,
  );
  for (const [filePath, contents] of Object.entries(options.currentFiles ?? {})) {
    writeFixtureFile(cwd, filePath, contents);
  }
  const headSha = commitFixture(cwd, "candidate");
  return { beforeSha, cwd, eventName: "push", headSha };
}

type TranslationMemoryOverrides = Record<string, string | string[]>;

function memoryEntry(overrides: TranslationMemoryOverrides = {}): string {
  const segmentId =
    typeof overrides.segment_id === "string" ? overrides.segment_id : "common.cancel";
  const source = typeof overrides.text === "string" ? overrides.text : "Cancel";
  return `${JSON.stringify({
    cache_key: `cache:${segmentId}`,
    segment_id: segmentId,
    text: source,
    text_hash: createHash("sha256").update(source.trim().split(/\s+/u).join(" ")).digest("hex"),
    translated: "Abbrechen",
    updated_at: "2026-08-01T00:00:00.000Z",
    provider: "original-provider",
    ...overrides,
  })}\n`;
}

describe("native locale refresh planning", () => {
  it("normalizes source locations, entry ordering, and JSON property ordering", () => {
    const left = JSON.stringify({
      version: 1,
      entries: [
        { id: "z", source: "Last", line: 2 },
        { id: "a", source: "First", line: 1 },
      ],
    });
    const right = JSON.stringify({
      entries: [
        { source: "First", line: 83, id: "a" },
        { source: "Last", line: 84, id: "z" },
      ],
      version: 1,
    });

    expect(normalizeNativeI18nInventory(left)).toBe(normalizeNativeI18nInventory(right));
  });

  it("skips code-only edits and inventory entries whose only change is a source line", () => {
    const fixture = createFixture({
      currentInventory: {
        ...defaultInventory,
        entries: [{ ...defaultInventory.entries[0], line: 99 }],
      },
      currentFiles: {
        "apps/macos/Sources/OpenClaw/Settings.swift": "// unrelated native refactor\n",
      },
    });

    expect(planNativeI18nRefresh(fixture)).toEqual({
      refresh: false,
      reason: "semantic-inputs-unchanged",
    });
  });

  it.each(["source", "description", "semanticKey"])(
    "refreshes when a native message %s changes",
    (field) => {
      const fixture = createFixture({
        currentInventory: {
          ...defaultInventory,
          entries: [{ ...defaultInventory.entries[0], [field]: `changed-${field}` }],
        },
      });

      expect(planNativeI18nRefresh(fixture)).toEqual({
        refresh: true,
        reason: "native-message-catalog-changed",
      });
    },
  );

  it("detects semantic changes in inventories larger than Node's default git output buffer", () => {
    const largeSource = `Relevant ${"x".repeat(1_100_000)}`;
    const fixture = createFixture({
      previousInventory: {
        ...defaultInventory,
        entries: [{ ...defaultInventory.entries[0], source: largeSource }],
      },
      currentInventory: {
        ...defaultInventory,
        entries: [{ ...defaultInventory.entries[0], source: `${largeSource} changed` }],
      },
    });

    expect(planNativeI18nRefresh(fixture)).toEqual({
      refresh: true,
      reason: "native-message-catalog-changed",
    });
  });

  it("refreshes when the Linux desktop semantic catalog changes", () => {
    const fixture = createFixture({
      currentLinuxMessages: {
        "desktop.welcome": {
          ...defaultLinuxMessages["desktop.welcome"],
          description: "Updated translator context.",
        },
      },
    });

    expect(planNativeI18nRefresh(fixture)).toEqual({
      refresh: true,
      reason: "linux-message-catalog-changed",
    });
  });

  it("ignores web-only English messages unrelated to native or desktop surfaces", () => {
    const fixture = createFixture({
      previousFiles: { [englishPath]: 'export const en = { analyticsOnly: "Graphs" };\n' },
      currentFiles: { [englishPath]: 'export const en = { analyticsOnly: "Charts" };\n' },
    });

    expect(planNativeI18nRefresh(fixture)).toEqual({
      refresh: false,
      reason: "semantic-inputs-unchanged",
    });
  });

  it("refreshes when shared English messages change even if their native inventory was unchanged", () => {
    const fixture = createFixture({
      previousFiles: { [englishPath]: 'export const en = { cancel: "Cancel" };\n' },
      currentFiles: { [englishPath]: 'export const en = { cancel: "Dismiss" };\n' },
    });

    expect(planNativeI18nRefresh(fixture)).toEqual({
      refresh: true,
      reason: "shared-native-english-changed",
    });
  });

  it("ignores timestamp/provider churn and unrelated web translation changes", () => {
    const fixture = createFixture({
      previousFiles: {
        [memoryPath]:
          memoryEntry() +
          memoryEntry({
            segment_id: "analytics.graph",
            text: "Graphs",
            translated: "Graphen",
          }),
      },
      currentFiles: {
        [memoryPath]:
          memoryEntry({ updated_at: "2026-08-04T00:00:00.000Z", provider: "new-provider" }) +
          memoryEntry({
            segment_id: "analytics.graph",
            text: "Graphs",
            translated: "Diagramme",
          }),
      },
    });

    expect(planNativeI18nRefresh(fixture)).toEqual({
      refresh: false,
      reason: "semantic-inputs-unchanged",
    });
  });

  it.each([
    ["a shared native key", { translated: "Schließen" }],
    [
      "a shared desktop message",
      { segment_id: "desktop.welcome", text: "Welcome aboard", translated: "Willkommen" },
    ],
  ])("refreshes when translation memory updates %s", (_label, nextEntry) => {
    const fixture = createFixture({
      previousFiles: { [memoryPath]: memoryEntry() },
      currentFiles: { [memoryPath]: memoryEntry(nextEntry) },
    });

    expect(planNativeI18nRefresh(fixture)).toEqual({
      refresh: true,
      reason: "shared-native-translations-changed",
    });
  });

  it("refreshes when a stale native translation becomes source-valid", () => {
    const fixture = createFixture({
      previousFiles: { [memoryPath]: memoryEntry({ text_hash: "stale-source-hash" }) },
      currentFiles: { [memoryPath]: memoryEntry() },
    });

    expect(planNativeI18nRefresh(fixture)).toEqual({
      refresh: true,
      reason: "shared-native-translations-changed",
    });
  });

  it("refreshes when a previously valid native translation becomes stale", () => {
    const fixture = createFixture({
      previousFiles: { [memoryPath]: memoryEntry() },
      currentFiles: { [memoryPath]: memoryEntry({ text_hash: "stale-source-hash" }) },
    });

    expect(planNativeI18nRefresh(fixture)).toEqual({
      refresh: true,
      reason: "shared-native-translations-changed",
    });
  });

  it.each(["added", "removed"])("refreshes when a relevant grouped alias is %s", (change) => {
    const withoutAlias = memoryEntry({
      cache_key: "shared-group",
      segment_id: "web.unrelated",
      text: "Cancel",
    });
    const withAlias = memoryEntry({
      cache_key: "shared-group",
      segment_id: "web.unrelated",
      segment_ids: ["common.cancel"],
      text: "Cancel",
    });
    const fixture = createFixture({
      previousFiles: { [memoryPath]: change === "added" ? withoutAlias : withAlias },
      currentFiles: { [memoryPath]: change === "added" ? withAlias : withoutAlias },
    });

    expect(planNativeI18nRefresh(fixture)).toEqual({
      refresh: true,
      reason: "shared-native-translations-changed",
    });
  });

  it("ignores unrelated aliases and same-English records without an approved semantic key", () => {
    const fixture = createFixture({
      previousFiles: {
        [memoryPath]: memoryEntry({
          cache_key: "unrelated-group",
          segment_id: "web.otherCancel",
          segment_ids: ["web.retired"],
          text: "Cancel",
        }),
      },
      currentFiles: {
        [memoryPath]: memoryEntry({
          cache_key: "unrelated-group",
          segment_id: "web.otherCancel",
          segment_ids: ["web.replacement"],
          text: "Cancel",
          translated: "Schließen",
        }),
      },
    });

    expect(planNativeI18nRefresh(fixture)).toEqual({
      refresh: false,
      reason: "semantic-inputs-unchanged",
    });
  });

  it("ignores irrelevant alias changes when the relevant effective translation is unchanged", () => {
    const fixture = createFixture({
      previousFiles: {
        [memoryPath]: memoryEntry({ segment_ids: ["web.retired"] }),
      },
      currentFiles: {
        [memoryPath]: memoryEntry({ segment_ids: ["web.replacement"] }),
      },
    });

    expect(planNativeI18nRefresh(fixture)).toEqual({
      refresh: false,
      reason: "semantic-inputs-unchanged",
    });
  });

  it("ignores stale grouped aliases until their hash matches each relevant source", () => {
    const fixture = createFixture({
      previousFiles: {
        [memoryPath]: memoryEntry({
          segment_id: "web.unrelated",
          segment_ids: ["common.cancel"],
          text: "Different English",
        }),
      },
      currentFiles: {
        [memoryPath]: memoryEntry({
          segment_id: "web.unrelated",
          segment_ids: ["common.cancel"],
          text: "Another English",
          translated: "Anders",
        }),
      },
    });

    expect(planNativeI18nRefresh(fixture)).toEqual({
      refresh: false,
      reason: "semantic-inputs-unchanged",
    });
  });

  it("uses the final entry for duplicate cache keys like the shared web catalog", () => {
    const fixture = createFixture({
      previousFiles: {
        [memoryPath]:
          memoryEntry({ cache_key: "duplicate", translated: "Ignored original" }) +
          memoryEntry({ cache_key: "duplicate", translated: "Abbrechen" }),
      },
      currentFiles: {
        [memoryPath]:
          memoryEntry({ cache_key: "duplicate", translated: "Different ignored original" }) +
          memoryEntry({ cache_key: "duplicate", translated: "Abbrechen" }),
      },
    });

    expect(planNativeI18nRefresh(fixture)).toEqual({
      refresh: false,
      reason: "semantic-inputs-unchanged",
    });
  });

  it("detects relevant changes in translation memories larger than the default git output buffer", () => {
    const largeProvider = "x".repeat(1_100_000);
    const fixture = createFixture({
      previousFiles: { [memoryPath]: memoryEntry({ provider: largeProvider }) },
      currentFiles: {
        [memoryPath]: memoryEntry({ provider: largeProvider, translated: "Schließen" }),
      },
    });

    expect(planNativeI18nRefresh(fixture)).toEqual({
      refresh: true,
      reason: "shared-native-translations-changed",
    });
  });

  it.each([
    "scripts/lib/control-ui-i18n-catalog.ts",
    "scripts/lib/control-ui-i18n-config.ts",
    "scripts/lib/control-ui-i18n-shared-catalog.ts",
    "scripts/lib/control-ui-i18n-sync-plan.ts",
    "scripts/lib/native-i18n-refresh-plan.mjs",
    "apps/linux/ui/generate-locales.ts",
    "ui/src/i18n/.i18n/glossary.de.json",
  ])("refreshes when semantic tooling or glossary changes: %s", (filePath) => {
    const fixture = createFixture({ currentFiles: { [filePath]: "updated\n" } });

    expect(planNativeI18nRefresh(fixture)).toEqual({
      refresh: true,
      reason: "semantic-tooling-or-glossary-changed",
    });
  });

  it("fails open for manual runs and unavailable push bases", () => {
    expect(
      planNativeI18nRefresh({ beforeSha: "", eventName: "workflow_dispatch", headSha: "" }),
    ).toEqual({ refresh: true, reason: "manual-dispatch" });
    expect(
      planNativeI18nRefresh({
        beforeSha: "0".repeat(40),
        eventName: "push",
        headSha: "a".repeat(40),
      }),
    ).toEqual({ refresh: true, reason: "unknown-push-base" });
  });

  it("writes exact GitHub Action outputs without acquiring credentials", () => {
    const fixture = createFixture();
    const outputPath = path.join(fixture.cwd, "github-output");
    const plannerPath = path.resolve("scripts/lib/native-i18n-refresh-plan.mjs");
    const result = spawnSync(process.execPath, [plannerPath], {
      cwd: fixture.cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        BEFORE_SHA: fixture.beforeSha,
        EVENT_NAME: fixture.eventName,
        GITHUB_OUTPUT: outputPath,
        HEAD_SHA: fixture.headSha,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(outputPath, "utf8")).toBe(
      "refresh=false\nreason=semantic-inputs-unchanged\n",
    );
  });
});

describe("shared native locale CI ownership", () => {
  it.each([
    "apps/linux/ui/messages.json",
    "apps/linux/ui/generate-locales.ts",
    "apps/linux/ui/locales.json",
    "apps/linux/ui/i18n.js",
    "apps/linux/ui/i18n.test.ts",
    "apps/linux/src-tauri/src/i18n.rs",
    "scripts/lib/control-ui-i18n-catalog.ts",
    "scripts/lib/control-ui-i18n-config.ts",
    "scripts/lib/control-ui-i18n-shared-catalog.ts",
    "scripts/lib/control-ui-i18n-sync-plan.ts",
    "scripts/lib/native-i18n-refresh-plan.mjs",
    "test/scripts/control-ui-i18n.test.ts",
    "test/scripts/control-ui-i18n-shared-catalog.test.ts",
    "test/scripts/control-ui-i18n-sync-plan.test.ts",
    "test/scripts/native-i18n-refresh-plan.test.ts",
    "ui/src/i18n/locales/en.ts",
    "ui/src/i18n/locales/en-agents.ts",
    "ui/src/i18n/.i18n/de.tm.jsonl",
  ])("routes shared semantic source through native verification: %s", (filePath) => {
    expect(shouldRunNativeI18n([filePath])).toBe(true);
  });

  it.each([
    "apps/linux/ui/i18n.js",
    "apps/linux/ui/i18n.test.ts",
    "apps/linux/src-tauri/src/i18n.rs",
  ])("routes desktop app source and tests through Node tooling: %s", (filePath) => {
    expect(detectChangedScope([filePath]).runNode).toBe(true);
  });

  it("allows source changes to introduce the co-owned runnable Linux locale bundle", () => {
    expect(() =>
      assertNativeGeneratedArtifactsIsolated([
        "apps/linux/ui/messages.json",
        "apps/linux/ui/generate-locales.ts",
        "apps/linux/ui/locales.json",
      ]),
    ).not.toThrow();
  });

  it("allows locale automation to refresh the Linux bundle alongside hard-generated artifacts", () => {
    expect(() =>
      assertNativeGeneratedArtifactsIsolated([
        "apps/.i18n/native/de.json",
        "apps/linux/ui/locales.json",
      ]),
    ).not.toThrow();
  });

  it("still rejects source changes mixed with hard-generated native translations", () => {
    expect(() =>
      assertNativeGeneratedArtifactsIsolated([
        "apps/linux/ui/messages.json",
        "apps/linux/ui/locales.json",
        "apps/.i18n/native/de.json",
      ]),
    ).toThrow(NativeGeneratedArtifactsMixedError);
  });
});
