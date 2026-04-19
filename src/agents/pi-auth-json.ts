import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { safeParseJsonWithSchema, safeParseWithSchema } from "../utils/zod-parse.js";
import { ensureAuthProfileStore } from "./auth-profiles/store.js";
import {
  piCredentialsEqual,
  resolvePiCredentialMapFromStore,
  type PiCredential,
} from "./pi-auth-credentials.js";

type AuthJsonShape = Record<string, unknown>;

const PiCredentialSchema: z.ZodType<PiCredential> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("api_key"),
    key: z.string(),
  }),
  z.object({
    type: z.literal("oauth"),
    access: z.string(),
    refresh: z.string(),
    expires: z.number(),
  }),
]);

const AuthJsonShapeSchema = z.record(z.string(), z.unknown());

async function readAuthJson(filePath: string): Promise<AuthJsonShape> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return safeParseJsonWithSchema(AuthJsonShapeSchema, raw) ?? {};
  } catch {
    return {};
  }
}

/**
 * pi-coding-agent's ModelRegistry/AuthStorage expects credentials in auth.json.
 *
 * OpenClaw stores credentials in auth-profiles.json instead. This helper
 * bridges all credentials into agentDir/auth.json so pi-coding-agent can
 * (a) consider providers authenticated and (b) include built-in models in its
 * registry/catalog output.
 *
 * Syncs all credential types: api_key, token (as api_key), and oauth.
 *
 * @deprecated Runtime auth now comes from OpenClaw auth-profiles snapshots.
 */
export async function ensurePiAuthJsonFromAuthProfiles(agentDir: string): Promise<{
  wrote: boolean;
  authPath: string;
}> {
  const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  const authPath = path.join(agentDir, "auth.json");
  const providerCredentials = resolvePiCredentialMapFromStore(store);
  if (Object.keys(providerCredentials).length === 0) {
    return { wrote: false, authPath };
  }

  const existing = await readAuthJson(authPath);
  let changed = false;

  for (const [provider, cred] of Object.entries(providerCredentials)) {
    const current = safeParseWithSchema(PiCredentialSchema, existing[provider]) ?? undefined;
    if (!piCredentialsEqual(current, cred)) {
      existing[provider] = cred;
      changed = true;
    }
  }

  if (!changed) {
    return { wrote: false, authPath };
  }

  await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(authPath, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });

  return { wrote: true, authPath };
}
