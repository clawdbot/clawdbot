import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { delimiter, dirname, join } from "node:path";

const CLIENT_ID_KEYS = ["CLAWDBOT_GEMINI_OAUTH_CLIENT_ID", "GEMINI_CLI_OAUTH_CLIENT_ID"];
const CLIENT_SECRET_KEYS = [
  "CLAWDBOT_GEMINI_OAUTH_CLIENT_SECRET",
  "GEMINI_CLI_OAUTH_CLIENT_SECRET",
];
const REDIRECT_URI = "http://localhost:8085/oauth2callback";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

const TIER_FREE = "free-tier";
const TIER_LEGACY = "legacy-tier";
const TIER_STANDARD = "standard-tier";

export type GeminiCliOAuthCredentials = {
  access: string;
  refresh: string;
  expires: number;
  email?: string;
  projectId: string;
};

export type GeminiCliOAuthContext = {
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
  log: (msg: string) => void;
  note: (message: string, title?: string) => Promise<void>;
  prompt: (message: string) => Promise<string>;
  progress: { update: (msg: string) => void; stop: (msg?: string) => void };
};

function resolveEnv(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

let cachedGeminiCliCredentials: { clientId: string; clientSecret: string } | null = null;

/** @internal */
export function clearCredentialsCache(): void {
  cachedGeminiCliCredentials = null;
}

/** Extracts OAuth credentials from the installed Gemini CLI's bundled oauth2.js. */
export function extractGeminiCliCredentials(): { clientId: string; clientSecret: string } | null {
  if (cachedGeminiCliCredentials) return cachedGeminiCliCredentials;

  try {
    const geminiPath = findInPath("gemini");
    if (!geminiPath) return null;

    const resolvedPath = realpathSync(geminiPath);
    const geminiCliDir = dirname(dirname(resolvedPath));

    const searchPaths = [
      join(geminiCliDir, "node_modules", "@google", "gemini-cli-core", "dist", "src", "code_assist", "oauth2.js"),
      join(geminiCliDir, "node_modules", "@google", "gemini-cli-core", "dist", "code_assist", "oauth2.js"),
    ];

    let content: string | null = null;
    for (const p of searchPaths) {
      if (existsSync(p)) {
        content = readFileSync(p, "utf8");
        break;
      }
    }
    if (!content) {
      const found = findFile(geminiCliDir, "oauth2.js", 10);
      if (found) content = readFileSync(found, "utf8");
    }
    if (!content) return null;

    const idMatch = content.match(/(\d+-[a-z0-9]+\.apps\.googleusercontent\.com)/);
    const secretMatch = content.match(/(GOCSPX-[A-Za-z0-9_-]+)/);
    if (idMatch && secretMatch) {
      cachedGeminiCliCredentials = { clientId: idMatch[1], clientSecret: secretMatch[1] };
      return cachedGeminiCliCredentials;
    }
  } catch {
    // Gemini CLI not installed or extraction failed
  }
  return null;
}

function findInPath(name: string): string | null {
  const exts = process.platform === "win32" ? [".cmd", ".bat", ".exe", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function findFile(dir: string, name: string, depth: number): string | null {
  if (depth <= 0) return null;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isFile() && e.name === name) return p;
      if (e.isDirectory() && !e.name.startsWith(".")) {
        const found = findFile(p, name, depth - 1);
        if (found) return found;
      }
    }
  } catch {}
  return null;
}

function resolveOAuthClientConfig(): { clientId: string; clientSecret?: string } {
  // 1. Check env vars first (user override)
  const envClientId = resolveEnv(CLIENT_ID_KEYS);
  const envClientSecret = resolveEnv(CLIENT_SECRET_KEYS);
  if (envClientId) {
    return { clientId: envClientId, clientSecret: envClientSecret };
  }

  // 2. Try to extract from installed Gemini CLI
  const extracted = extractGeminiCliCredentials();
  if (extracted) {
    return extracted;
  }

  // 3. No credentials available
  throw new Error(
    "Gemini CLI not found. Install it first: brew install gemini-cli (or npm install -g @google/gemini-cli), or set GEMINI_CLI_OAUTH_CLIENT_ID.",
  );
}

function isWSL(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const release = readFileSync("/proc/version", "utf8").toLowerCase();
    return release.includes("microsoft") || release.includes("wsl");
  } catch {
    return false;
  }
}

function isWSL2(): boolean {
  if (!isWSL()) return false;
  try {
    const version = readFileSync("/proc/version", "utf8").toLowerCase();
    return version.includes("wsl2") || version.includes("microsoft-standard");
  } catch {
    return false;
  }
}

function shouldUseManualOAuthFlow(isRemote: boolean): boolean {
  return isRemote || isWSL2();
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("hex");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function buildAuthUrl(challenge: string, verifier: string): string {
  const { clientId } = resolveOAuthClientConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: verifier,
    access_type: "offline",
    prompt: "consent",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

function parseCallbackInput(
  input: string,
  expectedState: string,
): { code: string; state: string } | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { error: "No input provided" };

  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? expectedState;
    if (!code) return { error: "Missing 'code' parameter in URL" };
    if (!state) return { error: "Missing 'state' parameter. Paste the full URL." };
    return { code, state };
  } catch {
    if (!expectedState) return { error: "Paste the full redirect URL, not just the code." };
    return { code: trimmed, state: expectedState };
  }
}

async function waitForLocalCallback(params: {
  expectedState: string;
  timeoutMs: number;
  onProgress?: (message: string) => void;
}): Promise<{ code: string; state: string }> {
  const port = 8085;
  const hostname = "localhost";
  const expectedPath = "/oauth2callback";

  return new Promise<{ code: string; state: string }>((resolve, reject) => {
    let timeout: NodeJS.Timeout | null = null;
    const server = createServer((req, res) => {
      try {
        const requestUrl = new URL(req.url ?? "/", `http://${hostname}:${port}`);
        if (requestUrl.pathname !== expectedPath) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain");
          res.end("Not found");
          return;
        }

        const error = requestUrl.searchParams.get("error");
        const code = requestUrl.searchParams.get("code")?.trim();
        const state = requestUrl.searchParams.get("state")?.trim();

        if (error) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain");
          res.end(`Authentication failed: ${error}`);
          finish(new Error(`OAuth error: ${error}`));
          return;
        }

        if (!code || !state) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain");
          res.end("Missing code or state");
          finish(new Error("Missing OAuth code or state"));
          return;
        }

        if (state !== params.expectedState) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain");
          res.end("Invalid state");
          finish(new Error("OAuth state mismatch"));
          return;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          "<!doctype html><html><head><meta charset='utf-8'/></head>" +
            "<body><h2>Gemini CLI OAuth complete</h2>" +
            "<p>You can close this window and return to Clawdbot.</p></body></html>",
        );

        finish(undefined, { code, state });
      } catch (err) {
        finish(err instanceof Error ? err : new Error("OAuth callback failed"));
      }
    });

    const finish = (err?: Error, result?: { code: string; state: string }) => {
      if (timeout) clearTimeout(timeout);
      try {
        server.close();
      } catch {
        // ignore close errors
      }
      if (err) {
        reject(err);
      } else if (result) {
        resolve(result);
      }
    };

    server.once("error", (err) => {
      finish(err instanceof Error ? err : new Error("OAuth callback server error"));
    });

    server.listen(port, hostname, () => {
      params.onProgress?.(`Waiting for OAuth callback on ${REDIRECT_URI}…`);
    });

    timeout = setTimeout(() => {
      finish(new Error("OAuth callback timeout"));
    }, params.timeoutMs);
  });
}

async function exchangeCodeForTokens(code: string, verifier: string): Promise<GeminiCliOAuthCredentials> {
  const { clientId, clientSecret } = resolveOAuthClientConfig();
  const body = new URLSearchParams({
    client_id: clientId,
    code,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed: ${errorText}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  if (!data.refresh_token) {
    throw new Error("No refresh token received. Please try again.");
  }

  const email = await getUserEmail(data.access_token);
  const projectId = await discoverProject(data.access_token);
  const expiresAt = Date.now() + data.expires_in * 1000 - 5 * 60 * 1000;

  return {
    refresh: data.refresh_token,
    access: data.access_token,
    expires: expiresAt,
    projectId,
    email,
  };
}

async function getUserEmail(accessToken: string): Promise<string | undefined> {
  try {
    const response = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.ok) {
      const data = (await response.json()) as { email?: string };
      return data.email;
    }
  } catch {
    // ignore
  }
  return undefined;
}

async function discoverProject(accessToken: string): Promise<string> {
  const envProject = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": "google-api-nodejs-client/9.15.1",
    "X-Goog-Api-Client": "gl-node/clawdbot",
  };

  const loadBody = {
    cloudaicompanionProject: envProject,
    metadata: {
      ideType: "IDE_UNSPECIFIED",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
      duetProject: envProject,
    },
  };

  let data: {
    currentTier?: { id?: string };
    cloudaicompanionProject?: string | { id?: string };
    allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
  } = {};

  try {
    const response = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`, {
      method: "POST",
      headers,
      body: JSON.stringify(loadBody),
    });

    if (!response.ok) {
      const errorPayload = await response.json().catch(() => null);
      if (isVpcScAffected(errorPayload)) {
        data = { currentTier: { id: TIER_STANDARD } };
      } else {
        throw new Error(`loadCodeAssist failed: ${response.status} ${response.statusText}`);
      }
    } else {
      data = (await response.json()) as typeof data;
    }
  } catch (err) {
    if (err instanceof Error) {
      throw err;
    }
    throw new Error("loadCodeAssist failed");
  }

  if (data.currentTier) {
    const project = data.cloudaicompanionProject;
    if (typeof project === "string" && project) return project;
    if (typeof project === "object" && project?.id) return project.id;
    if (envProject) return envProject;
    throw new Error(
      "This account requires GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID to be set.",
    );
  }

  const tier = getDefaultTier(data.allowedTiers);
  const tierId = tier?.id || TIER_FREE;
  if (tierId !== TIER_FREE && !envProject) {
    throw new Error(
      "This account requires GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID to be set.",
    );
  }

  const onboardBody: Record<string, unknown> = {
    tierId,
    metadata: {
      ideType: "IDE_UNSPECIFIED",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    },
  };
  if (tierId !== TIER_FREE && envProject) {
    onboardBody.cloudaicompanionProject = envProject;
    (onboardBody.metadata as Record<string, unknown>).duetProject = envProject;
  }

  const onboardResponse = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`, {
    method: "POST",
    headers,
    body: JSON.stringify(onboardBody),
  });

  if (!onboardResponse.ok) {
    throw new Error(`onboardUser failed: ${onboardResponse.status} ${onboardResponse.statusText}`);
  }

  let lro = (await onboardResponse.json()) as {
    done?: boolean;
    name?: string;
    response?: { cloudaicompanionProject?: { id?: string } };
  };

  if (!lro.done && lro.name) {
    lro = await pollOperation(lro.name, headers);
  }

  const projectId = lro.response?.cloudaicompanionProject?.id;
  if (projectId) return projectId;
  if (envProject) return envProject;

  throw new Error(
    "Could not discover or provision a Google Cloud project. Set GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID.",
  );
}

function isVpcScAffected(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") return false;
  const details = (error as { details?: unknown[] }).details;
  if (!Array.isArray(details)) return false;
  return details.some(
    (item) =>
      typeof item === "object" && item && (item as { reason?: string }).reason === "SECURITY_POLICY_VIOLATED",
  );
}

function getDefaultTier(
  allowedTiers?: Array<{ id?: string; isDefault?: boolean }>,
): { id?: string } | undefined {
  if (!allowedTiers?.length) return { id: TIER_LEGACY };
  return allowedTiers.find((tier) => tier.isDefault) ?? { id: TIER_LEGACY };
}

async function pollOperation(
  operationName: string,
  headers: Record<string, string>,
): Promise<{ done?: boolean; response?: { cloudaicompanionProject?: { id?: string } } }> {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const response = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal/${operationName}`, {
      headers,
    });
    if (!response.ok) continue;
    const data = (await response.json()) as {
      done?: boolean;
      response?: { cloudaicompanionProject?: { id?: string } };
    };
    if (data.done) return data;
  }
  throw new Error("Operation polling timeout");
}

export async function loginGeminiCliOAuth(ctx: GeminiCliOAuthContext): Promise<GeminiCliOAuthCredentials> {
  const needsManual = shouldUseManualOAuthFlow(ctx.isRemote);
  await ctx.note(
    needsManual
      ? [
          "You are running in a remote/VPS environment.",
          "A URL will be shown for you to open in your LOCAL browser.",
          "After signing in, copy the redirect URL and paste it back here.",
        ].join("\n")
      : [
          "Browser will open for Google authentication.",
          "Sign in with your Google account for Gemini CLI access.",
          "The callback will be captured automatically on localhost:8085.",
        ].join("\n"),
    "Gemini CLI OAuth",
  );

  const { verifier, challenge } = generatePkce();
  const authUrl = buildAuthUrl(challenge, verifier);

  if (needsManual) {
    ctx.progress.update("OAuth URL ready");
    ctx.log(`\nOpen this URL in your LOCAL browser:\n\n${authUrl}\n`);
    ctx.progress.update("Waiting for you to paste the callback URL...");
    const callbackInput = await ctx.prompt("Paste the redirect URL here: ");
    const parsed = parseCallbackInput(callbackInput, verifier);
    if ("error" in parsed) throw new Error(parsed.error);
    if (parsed.state !== verifier) {
      throw new Error("OAuth state mismatch - please try again");
    }
    ctx.progress.update("Exchanging authorization code for tokens...");
    return exchangeCodeForTokens(parsed.code, verifier);
  }

  ctx.progress.update("Complete sign-in in browser...");
  try {
    await ctx.openUrl(authUrl);
  } catch {
    ctx.log(`\nOpen this URL in your browser:\n\n${authUrl}\n`);
  }

  try {
    const { code } = await waitForLocalCallback({
      expectedState: verifier,
      timeoutMs: 5 * 60 * 1000,
      onProgress: (msg) => ctx.progress.update(msg),
    });
    ctx.progress.update("Exchanging authorization code for tokens...");
    return await exchangeCodeForTokens(code, verifier);
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes("EADDRINUSE") ||
        err.message.includes("port") ||
        err.message.includes("listen"))
    ) {
      ctx.progress.update("Local callback server failed. Switching to manual mode...");
      ctx.log(`\nOpen this URL in your LOCAL browser:\n\n${authUrl}\n`);
      const callbackInput = await ctx.prompt("Paste the redirect URL here: ");
      const parsed = parseCallbackInput(callbackInput, verifier);
      if ("error" in parsed) throw new Error(parsed.error);
      if (parsed.state !== verifier) {
        throw new Error("OAuth state mismatch - please try again");
      }
      ctx.progress.update("Exchanging authorization code for tokens...");
      return exchangeCodeForTokens(parsed.code, verifier);
    }
    throw err;
  }
}
