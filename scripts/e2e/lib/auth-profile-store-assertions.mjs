// Shared auth profile store assertions for install/onboard E2E proof.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "../../lib/record-shared.mjs";

// Schema v7 moved primary auth ownership from each agent to shared state.
// v13 later folded that shared row into config_machine_state.
const SHARED_AUTH_PROFILE_STORE_SCHEMA_VERSION = 7;
const AUTH_PROFILE_MACHINE_STATE_SCHEMA_VERSION = 13;

function readSharedAuthProfileStore(stateDir) {
  const dbPath = path.join(stateDir, "state", "openclaw.sqlite");
  if (!fs.existsSync(dbPath)) {
    return { ownsStore: false, text: "" };
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const schemaVersion = db.prepare("PRAGMA user_version").get()?.user_version;
    if (!Number.isInteger(schemaVersion)) {
      throw new Error(`invalid state schema version ${String(schemaVersion)}`);
    }
    if (schemaVersion < SHARED_AUTH_PROFILE_STORE_SCHEMA_VERSION) {
      return { ownsStore: false, text: "" };
    }
    // Release candidates own their persisted schema. Never let a retired row
    // mask a missing canonical row once the v13 fold has occurred.
    const storage =
      schemaVersion >= AUTH_PROFILE_MACHINE_STATE_SCHEMA_VERSION
        ? {
            column: "value_json",
            key: "authProfiles.store",
            query: "SELECT value_json FROM config_machine_state WHERE state_key = ?",
            table: "config_machine_state",
          }
        : {
            column: "store_json",
            key: "shared",
            query: "SELECT store_json FROM auth_profile_stores WHERE store_key = ?",
            table: "auth_profile_stores",
          };
    const schema = db
      .prepare("SELECT type FROM sqlite_schema WHERE name = ? LIMIT 1")
      .get(storage.table);
    if (!schema) {
      return {
        // v7 selects the shared owner. Do not let a missing canonical table
        // reactivate the retired per-agent contract for a broken target.
        ownsStore: true,
        text: "",
      };
    }
    if (schema.type !== "table") {
      throw new Error(`${storage.table} is ${String(schema.type)}, not a table`);
    }
    const row = db.prepare(storage.query).get(storage.key);
    const value = row?.[storage.column];
    return { ownsStore: true, text: typeof value === "string" ? value : "" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read the shared auth profile store: ${detail}`, {
      cause: error,
    });
  } finally {
    db?.close();
  }
}

export function readSharedAuthProfileStoreText(stateDir) {
  return readSharedAuthProfileStore(stateDir).text;
}

function readLegacyPrimaryAuthProfileStoreText(stateDir) {
  const dbPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  if (!fs.existsSync(dbPath)) {
    return "";
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const schema = db
      .prepare("SELECT type FROM sqlite_schema WHERE name = ? LIMIT 1")
      .get("auth_profile_store");
    if (!schema) {
      return "";
    }
    if (schema.type !== "table") {
      throw new Error(`auth_profile_store is ${String(schema.type)}, not a table`);
    }
    const row = db
      .prepare("SELECT store_json FROM auth_profile_store WHERE store_key = ?")
      .get("primary");
    return typeof row?.store_json === "string" ? row.store_json : "";
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read the legacy primary auth profile store: ${detail}`, {
      cause: error,
    });
  } finally {
    db?.close();
  }
}

// Frozen releases validate the auth store their own persisted schema owns.
// This keeps a missing modern row from being masked by a retired agent row.
export function readCanonicalAuthProfileStoreText(stateDir) {
  const shared = readSharedAuthProfileStore(stateDir);
  return shared.ownsStore ? shared.text : readLegacyPrimaryAuthProfileStoreText(stateDir);
}

export function assertNoLegacyPrimaryAuthRows(stateDir) {
  if (!readSharedAuthProfileStore(stateDir).ownsStore) {
    return;
  }
  const dbPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  if (!fs.existsSync(dbPath)) {
    return;
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const legacyRows = [
      {
        table: "auth_profile_store",
        query: "SELECT 1 AS present FROM auth_profile_store WHERE store_key = ? LIMIT 1",
      },
      {
        table: "auth_profile_state",
        query: "SELECT 1 AS present FROM auth_profile_state WHERE state_key = ? LIMIT 1",
      },
    ];
    for (const entry of legacyRows) {
      const schema = db
        .prepare("SELECT type FROM sqlite_schema WHERE name = ? LIMIT 1")
        .get(entry.table);
      if (!schema) {
        continue;
      }
      if (schema.type !== "table") {
        throw new Error(`${entry.table} is ${String(schema.type)}, not a table`);
      }
      if (db.prepare(entry.query).get("primary")) {
        throw new Error(`onboard preserved a retired primary row in ${entry.table}`);
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("onboard preserved a retired")) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not validate the main-agent auth database: ${detail}`, {
      cause: error,
    });
  } finally {
    db?.close();
  }
}

function hasExpectedOpenAiEnvRef(profile) {
  if (!isRecord(profile)) {
    return false;
  }
  const keyRef = profile.keyRef;
  return (
    profile.type === "api_key" &&
    profile.provider === "openai" &&
    !Object.hasOwn(profile, "key") &&
    isRecord(keyRef) &&
    keyRef.source === "env" &&
    keyRef.provider === "default" &&
    keyRef.id === "OPENAI_API_KEY"
  );
}

function hasInlineOpenAiKey(profile) {
  return (
    isRecord(profile) &&
    profile.type === "api_key" &&
    profile.provider === "openai" &&
    Object.hasOwn(profile, "key")
  );
}

export function assertOpenAiEnvAuthProfileStore(storeJson, options = {}) {
  const missingMessage = options.missingMessage ?? "auth profile store was not persisted";
  const envRefMessage =
    options.envRefMessage ?? "auth profile did not persist OPENAI_API_KEY env ref";
  const rawKeyMessage = options.rawKeyMessage ?? "auth profile persisted an inline OpenAI key";
  const rawKeyNeedle = options.rawKeyNeedle;

  if (!storeJson) {
    throw new Error(missingMessage);
  }
  if (rawKeyNeedle && storeJson.includes(rawKeyNeedle)) {
    throw new Error(rawKeyMessage);
  }

  let store;
  try {
    store = JSON.parse(storeJson);
  } catch {
    throw new Error(envRefMessage);
  }
  const profiles = isRecord(store) && isRecord(store.profiles) ? store.profiles : null;
  if (!profiles) {
    throw new Error(envRefMessage);
  }
  const profileValues = Object.values(profiles);
  if (profileValues.some(hasInlineOpenAiKey)) {
    throw new Error(rawKeyMessage);
  }
  if (!profileValues.some(hasExpectedOpenAiEnvRef)) {
    throw new Error(envRefMessage);
  }
}
