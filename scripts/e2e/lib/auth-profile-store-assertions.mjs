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
    const row = db
      .prepare("SELECT store_json FROM auth_profile_stores WHERE store_key = ?")
      .get("shared");
    return typeof row?.store_json === "string" ? row.store_json : "";
  } catch {
    return "";
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
