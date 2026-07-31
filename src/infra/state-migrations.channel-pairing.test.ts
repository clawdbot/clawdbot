import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

describe("legacy channel pairing state migration", () => {
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
      configuredAccountIds: { telegram: ["alerts", "ops/bot"] },
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
      allowFrom: { default: ["1001"], alerts: ["1002"], "ops/bot": ["1003"] },
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
      configuredAccountIds: { "custom-channel": ["primary"] },
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

  it("leaves ambiguous sanitized account filenames in place", async () => {
    const { env, sourceDir } = await createFixture();
    const filePath = path.join(sourceDir, "telegram-ops_bot-allowFrom.json");
    writeJson(filePath, { version: 1, allowFrom: ["1003"] });

    const detected = detectLegacyChannelPairingState({
      sourceDir,
      configuredAccountIds: { telegram: ["ops/bot", "ops_bot"] },
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
      configuredAccountIds: { telegram: ["business"] },
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
