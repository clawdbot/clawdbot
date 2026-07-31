import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { generatePKCE } from "./openai-chatgpt-pkce.runtime.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const DEFAULT_CALLBACK_HOST = "localhost";
const LOOPBACK_CALLBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const SCOPE = "openid profile email offline_access";

const loadNodeCrypto = createLazyRuntimeModule(() =>
  import("node:crypto").then((cryptoModule) => cryptoModule.randomBytes),
);

export function resolveOpenAICallbackHost(env: NodeJS.ProcessEnv = process.env): string {
  const host = env.OPENCLAW_OAUTH_CALLBACK_HOST?.trim() || DEFAULT_CALLBACK_HOST;
  if (!LOOPBACK_CALLBACK_HOSTS.has(host)) {
    throw new Error("OpenAI Codex OAuth callback host must be localhost, 127.0.0.1, or ::1");
  }
  return host;
}

export function resolveOpenAIRedirectUri(host: string): string {
  const hostForUrl = host === "::1" ? "[::1]" : host;
  const url = new URL(`http://${hostForUrl}:${CALLBACK_PORT}`);
  url.pathname = CALLBACK_PATH;
  return url.toString();
}

export async function createOpenAIAuthorizationFlow(
  originator: string,
  redirectUri: string,
): Promise<{ verifier: string; redirectUri: string; state: string; url: string }> {
  if (typeof process === "undefined" || (!process.versions?.node && !process.versions?.bun)) {
    throw new Error("OpenAI Codex OAuth is only available in Node.js environments");
  }
  const [{ verifier, challenge }, randomBytes] = await Promise.all([
    generatePKCE(),
    loadNodeCrypto(),
  ]);
  const state = randomBytes(16).toString("hex");
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", originator);
  return { verifier, redirectUri, state, url: url.toString() };
}
