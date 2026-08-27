// Shared auth profile store assertions for install/onboard E2E proof.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "../../lib/record-shared.mjs";

export function readSharedAuthProfileStoreText(stateDir) {
  const dbPath = path.join(stateDir, "state", "openclaw.sqlite");
  if (!fs.existsSync(dbPath)) {
    return "";
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const schema = db
      .prepare("SELECT type FROM sqlite_schema WHERE name = ? LIMIT 1")
      .get("config_machine_state");
    if (!schema) {
      return "";
    }
    if (schema.type !== "table") {
      throw new Error(`config_machine_state is ${String(schema.type)}, not a table`);
    }
    const row = db
      .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
      .get("authProfiles.store");
    return typeof row?.value_json === "string" ? row.value_json : "";
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read the shared auth profile store: ${detail}`, {
      cause: error,
    });
  } finally {
    db?.close();
  }
}

export function assertNoLegacyPrimaryAuthRows(stateDir) {
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
