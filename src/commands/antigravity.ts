import fs from "node:fs/promises";
import path from "node:path";
import { loginAntigravityVpsAware } from "./antigravity-oauth.js";
import { writeOAuthCredentials } from "./onboard-auth.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveOAuthPath } from "../config/paths.js";
import { getAntigravityAccounts } from "../agents/model-auth.js";

// Re-implementing simplified loadOAuthStorage to avoid circular deps or complexity
async function loadOAuthStorage() {
  const p = resolveOAuthPath();
  try {
    const content = await fs.readFile(p, "utf8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

export async function antigravityAddCommand(runtime: RuntimeEnv) {
  runtime.log("Starting Antigravity login...");

  const creds = await loginAntigravityVpsAware(
    (url) => {
      runtime.log("\nOpen this URL to authorize:");
      runtime.log(url + "\n");
    },
    (msg) => runtime.log(msg),
  );

  if (creds && creds.email) {
    const key = `google-antigravity:${creds.email}`;
    // We cast to any because OAuthProvider is a strict union type in the library,
    // but the storage underlying implementation handles string keys.
    await writeOAuthCredentials(key as any, creds);
    runtime.log(`Successfully added account: ${creds.email}`);
  } else {
    throw new Error("Login failed or email could not be retrieved.");
  }
}

export async function antigravityListCommand(runtime: RuntimeEnv) {
  const storage = await loadOAuthStorage();
  const accounts = getAntigravityAccounts(storage);

  if (accounts.length === 0) {
    runtime.log("No Antigravity accounts found.");
    return;
  }

  runtime.log("Antigravity Accounts:");
  for (const acc of accounts) {
    runtime.log(`- ${acc}`);
  }
}
