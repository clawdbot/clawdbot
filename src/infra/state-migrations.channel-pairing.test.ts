import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveOAuthDir } from "../config/paths.js";
import {
  readChannelPairingStateSnapshot,
  writeChannelPairingStateSnapshot,
} from "../pairing/pairing-store-sqlite.test-helpers.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  detectLegacyChannelPairingState,
  migrateLegacyChannelPairingState,
} from "./state-migrations.channel-pairing.js";

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
});

async function createFixture() {
  const stateDir = await tempDirs.make("openclaw-pairing-migration-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const sourceDir = resolveOAuthDir(env, stateDir);
  fs.mkdirSync(sourceDir, { recursive: true });
  return { env, sourceDir };
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isCaseSensitiveDirectory(directory: string): boolean {
  const marker = path.join(directory, "case-check");
  fs.writeFileSync(marker, "case", "utf8");
  const caseSensitive = !fs.existsSync(path.join(directory, "CASE-CHECK"));
  fs.rmSync(marker);
  return caseSensitive;
}

describe("legacy channel pairing state migration", () => {
  it("marks configured-channel account discovery as deferred without resolving accounts", async () => {
    const { sourceDir } = await createFixture();
    writeJson(path.join(sourceDir, "custom-channel-allowFrom.json"), ["legacy-user"]);
    const resolveAccounts = vi.fn(() => ({
      defaultAccountIds: { "custom-channel": "primary" },
    }));

    const detected = detectLegacyChannelPairingState({
      sourceDir,
      configuredChannelIds: ["custom-channel"],
      resolveAccounts,
      deferConfiguredAccountDiscovery: true,
    });

    expect(detected.accountDiscoveryDeferred).toBe(true);
    expect(resolveAccounts).not.toHaveBeenCalled();
  });

  it("does not defer pairing requests or built-in explicit default accounts", async () => {
    const { sourceDir } = await createFixture();
    writeJson(path.join(sourceDir, "telegram-pairing.json"), { version: 1, requests: [] });
    writeJson(path.join(sourceDir, "whatsapp-default-allowFrom.json"), ["legacy-user"]);

    const detected = detectLegacyChannelPairingState({
      sourceDir,
      configuredChannelIds: ["custom-channel", "whatsapp"],
      deferConfiguredAccountDiscovery: true,
    });

    expect(detected.accountDiscoveryDeferred).toBe(false);
  });

  it("imports pairing requests and scoped allowFrom entries into SQLite", async () => {
    const { env, sourceDir } = await createFixture();
    const createdAt = new Date().toISOString();
    writeJson(path.join(sourceDir, "telegram-pairing.json"), {
      version: 1,
      requests: [
        {
          id: "pending-user",
          code: "PAIRME12",
          createdAt,
          lastSeenAt: createdAt,
          meta: { accountId: "alerts" },
        },
      ],
    });
    writeJson(path.join(sourceDir, "telegram-allowFrom.json"), {
      version: 1,
      allowFrom: ["1001", "1001", "*"],
    });
    writeJson(path.join(sourceDir, "telegram-alerts-allowFrom.json"), ["1002"]);
    writeJson(path.join(sourceDir, "telegram-ops_bot-allowFrom.json"), ["1003"]);

    const detected = detectLegacyChannelPairingState({
      sourceDir,
      resolveAccounts: () => ({ accountIds: { telegram: ["alerts", "ops_bot"] } }),
    });
    expect(detected.hasLegacy).toBe(true);
    const result = migrateLegacyChannelPairingState({ detected, env });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(4);
    expect(fs.readdirSync(sourceDir)).toEqual([]);
    expect(readChannelPairingStateSnapshot("telegram", env)).toEqual({
      version: 1,
      requests: [
        {
          id: "pending-user",
          code: "PAIRME12",
          createdAt,
          lastSeenAt: createdAt,
          meta: { accountId: "alerts" },
        },
      ],
      allowFrom: { default: ["1001"], alerts: ["1002"], ops_bot: ["1003"] },
    });
    expect(fs.existsSync(path.join(path.dirname(sourceDir), "state", "openclaw.sqlite"))).toBe(
      true,
    );
  });

  it("imports a built-in channel's explicit default account without channel config", async () => {
    const { env, sourceDir } = await createFixture();
    const filePath = path.join(sourceDir, "whatsapp-default-allowFrom.json");
    writeJson(filePath, {
      version: 1,
      allowFrom: ["+12025550101", "+12025550102", "+12025550103"],
    });

    const detected = detectLegacyChannelPairingState({ sourceDir });
    const result = migrateLegacyChannelPairingState({ detected, env });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated 3 whatsapp/default allowFrom entries → shared SQLite state",
    ]);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(readChannelPairingStateSnapshot("whatsapp", env).allowFrom).toEqual({
      default: ["+12025550101", "+12025550102", "+12025550103"],
    });
  });

  it("merges with authoritative SQLite rows and keeps unreadable sources", async () => {
    const { env, sourceDir } = await createFixture();
    const createdAt = new Date().toISOString();
    writeChannelPairingStateSnapshot(
      "custom-channel",
      {
        version: 1,
        requests: [
          {
            id: "existing",
            code: "EXISTING",
            createdAt,
            lastSeenAt: createdAt,
            meta: { accountId: "primary" },
          },
        ],
        allowFrom: { primary: ["kept"] },
      },
      env,
    );
    writeJson(path.join(sourceDir, "custom-channel-primary-allowFrom.json"), {
      version: 1,
      allowFrom: ["imported"],
    });
    fs.writeFileSync(path.join(sourceDir, "custom-channel-pairing.json"), "{broken\n", "utf8");

    const detected = detectLegacyChannelPairingState({
      sourceDir,
      configuredChannelIds: ["custom-channel"],
      resolveAccounts: () => ({ accountIds: { "custom-channel": ["primary"] } }),
    });
    const result = migrateLegacyChannelPairingState({ detected, env });

    expect(result.warnings).toEqual([
      expect.stringContaining("Legacy channel pairing file unreadable; left in place"),
    ]);
    expect(fs.existsSync(path.join(sourceDir, "custom-channel-pairing.json"))).toBe(true);
    expect(fs.existsSync(path.join(sourceDir, "custom-channel-primary-allowFrom.json"))).toBe(
      false,
    );
    expect(readChannelPairingStateSnapshot("custom-channel", env)).toEqual({
      version: 1,
      requests: [
        {
          id: "existing",
          code: "EXISTING",
          createdAt,
          lastSeenAt: createdAt,
          meta: { accountId: "primary" },
        },
      ],
      allowFrom: { primary: ["kept", "imported"] },
    });
  });

  it("matches the raw account key instead of a punctuation-normalized sibling", async () => {
    const { env, sourceDir } = await createFixture();
    const filePath = path.join(sourceDir, "telegram-Ops_Bot-allowFrom.json");
    writeJson(filePath, { version: 1, allowFrom: ["1003"] });

    const detected = detectLegacyChannelPairingState({
      sourceDir,
      resolveAccounts: () => ({ accountIds: { telegram: ["ops/bot", "ops_bot"] } }),
    });
    const result = migrateLegacyChannelPairingState({ detected, env });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated 1 telegram/ops_bot allowFrom entry → shared SQLite state",
    ]);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(readChannelPairingStateSnapshot("telegram", env).allowFrom).toEqual({
      ops_bot: ["1003"],
    });
  });

  it("leaves case-folded filename collision sets in place", async () => {
    const { env, sourceDir } = await createFixture();
    const caseSensitive = isCaseSensitiveDirectory(sourceDir);
    if (!caseSensitive) {
      expect(caseSensitive).toBe(false);
      return;
    }
    const filenames = [
      "telegram-AmbiguousAcct-allowFrom.json",
      "telegram-AMBIGUOUSACCT-allowFrom.json",
      "telegram-exactacct-allowFrom.json",
      "telegram-ExactAcct-allowFrom.json",
    ];
    for (const [index, filename] of filenames.entries()) {
      writeJson(path.join(sourceDir, filename), { version: 1, allowFrom: [`user-${index}`] });
    }

    const detected = detectLegacyChannelPairingState({
      sourceDir,
      resolveAccounts: () => ({ accountIds: { telegram: ["ambiguousacct", "exactacct"] } }),
    });
    const result = migrateLegacyChannelPairingState({ detected, env });

    expect(result.changes).toEqual([]);
    expect(result.warnings).toHaveLength(filenames.length);
    expect(result.warnings).toEqual(
      expect.arrayContaining(
        filenames.map((filename) =>
          expect.stringContaining(
            `Legacy channel allowFrom channel/account is ambiguous; left in place at ${path.join(sourceDir, filename)}`,
          ),
        ),
      ),
    );
    expect(filenames.every((filename) => fs.existsSync(path.join(sourceDir, filename)))).toBe(true);
    expect(readChannelPairingStateSnapshot("telegram", env).allowFrom).toEqual({});
  });

  it.each([
    { filenameAccountKey: "ops..bot", configuredAccountId: "ops_bot" },
    { filenameAccountKey: "ops_bot", configuredAccountId: "ops.bot" },
  ])(
    "does not re-encode $filenameAccountKey into $configuredAccountId",
    async ({ filenameAccountKey, configuredAccountId }) => {
      const { env, sourceDir } = await createFixture();
      const filePath = path.join(sourceDir, `telegram-${filenameAccountKey}-allowFrom.json`);
      writeJson(filePath, { version: 1, allowFrom: ["1003"] });

      const detected = detectLegacyChannelPairingState({
        sourceDir,
        resolveAccounts: () => ({ accountIds: { telegram: [configuredAccountId] } }),
      });
      const result = migrateLegacyChannelPairingState({ detected, env });

      expect(result.changes).toEqual([]);
      expect(result.warnings).toEqual([
        expect.stringContaining(
          "Legacy channel allowFrom channel/account is unresolved; left in place",
        ),
      ]);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(readChannelPairingStateSnapshot("telegram", env).allowFrom).toEqual({});
    },
  );

  it("ignores invalid account candidates while resolving scoped filenames", async () => {
    const { env, sourceDir } = await createFixture();
    const filePath = path.join(sourceDir, "telegram-alerts-allowFrom.json");
    writeJson(filePath, { version: 1, allowFrom: ["1003"] });

    const detected = detectLegacyChannelPairingState({
      sourceDir,
      resolveAccounts: () => ({ accountIds: { telegram: ["*", "alerts"] } }),
    });
    const result = migrateLegacyChannelPairingState({ detected, env });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated 1 telegram/alerts allowFrom entry → shared SQLite state",
    ]);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(readChannelPairingStateSnapshot("telegram", env).allowFrom).toEqual({
      alerts: ["1003"],
    });
  });

  it("leaves nonliteral default filename suffixes unresolved", async () => {
    const { env, sourceDir } = await createFixture();
    const filePath = path.join(sourceDir, "telegram-DEFAULT-allowFrom.json");
    writeJson(filePath, { version: 1, allowFrom: ["1003"] });

    const detected = detectLegacyChannelPairingState({
      sourceDir,
      resolveAccounts: () => ({ accountIds: { telegram: ["default"] } }),
    });
    const result = migrateLegacyChannelPairingState({ detected, env });

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining(
        "Legacy channel allowFrom channel/account is unresolved; left in place",
      ),
    ]);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(readChannelPairingStateSnapshot("telegram", env).allowFrom).toEqual({});
  });

  it("does not infer default accounts for external channels", async () => {
    const { env, sourceDir } = await createFixture();
    const filePath = path.join(sourceDir, "custom-channel-default-allowFrom.json");
    writeJson(filePath, { version: 1, allowFrom: ["external-user"] });

    const detected = detectLegacyChannelPairingState({
      sourceDir,
      configuredChannelIds: ["custom-channel"],
    });
    const result = migrateLegacyChannelPairingState({ detected, env });

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining(
        "Legacy channel allowFrom channel/account is unresolved; left in place",
      ),
    ]);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(readChannelPairingStateSnapshot("custom-channel", env).allowFrom).toEqual({});
  });

  it("leaves overlapping channel and account filename interpretations in place", async () => {
    const { env, sourceDir } = await createFixture();
    const filePath = path.join(sourceDir, "telegram-business-allowFrom.json");
    writeJson(filePath, { version: 1, allowFrom: ["1004"] });

    const detected = detectLegacyChannelPairingState({
      sourceDir,
      configuredChannelIds: ["telegram-business"],
      resolveAccounts: () => ({ accountIds: { telegram: ["business"] } }),
    });
    const result = migrateLegacyChannelPairingState({ detected, env });

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining(
        "Legacy channel allowFrom channel/account is ambiguous; left in place",
      ),
    ]);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(readChannelPairingStateSnapshot("telegram", env).allowFrom).toEqual({});
    expect(readChannelPairingStateSnapshot("telegram-business", env).allowFrom).toEqual({});
  });
});
