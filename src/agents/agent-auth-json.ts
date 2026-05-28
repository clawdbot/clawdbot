import path from "node:path";
import { z } from "zod";
import { privateFileStore } from "../infra/private-file-store.js";
import { safeParseWithSchema } from "../utils/zod-parse.js";
import {
  agentCredentialsEqual,
  resolveAgentCredentialMapFromStore,
  type AgentCredential,
} from "./agent-auth-credentials.js";
import { ensureAuthProfileStore } from "./auth-profiles/store.js";

type AuthJsonShape = Record<string, unknown>;

const AgentCredentialSchema: z.ZodType<AgentCredential> = z.discriminatedUnion("type", [
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

async function readAuthJson(rootDir: string, filePath: string): Promise<AuthJsonShape> {
  try {
    const parsed = await privateFileStore(rootDir).readJsonIfExists(
      path.relative(rootDir, filePath),
    );
    return safeParseWithSchema(AuthJsonShapeSchema, parsed) ?? {};
  } catch {
    return {};
  }
}

/**
 * session runtime's ModelRegistry/AuthStorage expects credentials in auth.json.
 *
 * OpenClaw stores credentials in auth-profiles.json instead. This helper
 * bridges all credentials into agentDir/auth.json so session runtime can
 * consider provider-owned configured models authenticated.
 *
 * Syncs all credential types: api_key, token (as api_key), and oauth.
 *
 * @deprecated Runtime auth now comes from OpenClaw auth-profiles snapshots.
 */
export async function ensureAgentAuthJsonFromAuthProfiles(agentDir: string): Promise<{
  wrote: boolean;
  authPath: string;
}> {
  const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  const authPath = path.join(agentDir, "auth.json");
  const providerCredentials = resolveAgentCredentialMapFromStore(store);
  if (Object.keys(providerCredentials).length === 0) {
    return { wrote: false, authPath };
  }

  const existing = await readAuthJson(agentDir, authPath);
  let changed = false;

  for (const [provider, cred] of Object.entries(providerCredentials)) {
    const current = safeParseWithSchema(AgentCredentialSchema, existing[provider]) ?? undefined;
    if (!agentCredentialsEqual(current, cred)) {
      existing[provider] = cred;
      changed = true;
    }
  }

  if (!changed) {
    return { wrote: false, authPath };
  }

  await privateFileStore(agentDir).writeJson(path.basename(authPath), existing, {
    trailingNewline: true,
  });

  return { wrote: true, authPath };
}
