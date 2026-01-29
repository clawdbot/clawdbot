import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";
import { ProxyAgent } from "undici";

// OAuth constants - decoded from pi-ai's base64 encoded values to stay in sync
const decode = (s: string) => Buffer.from(s, "base64").toString();
const CLIENT_ID = decode(
  "MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
);
const CLIENT_SECRET = decode("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=");
const REDIRECT_URI = "http://localhost:51121/oauth-callback";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_PROJECT_ID = "rising-fact-p41fc";
const DEFAULT_MODEL = "google-antigravity/claude-opus-4-5-thinking";

const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

const CODE_ASSIST_ENDPOINTS = [
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
];

const PROXY_ENV_KEYS = [
  "CLAWDBOT_HTTPS_PROXY",
  "CLAWDBOT_HTTP_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "https_proxy",
  "http_proxy",
];

function resolveProxyUrl(): string | undefined {
  for (const key of PROXY_ENV_KEYS) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

const proxyUrl = resolveProxyUrl();
const proxyAgent = proxyUrl
  ? new ProxyAgent({
      uri: proxyUrl,
      requestTls: { maxVersion: "TLSv1.2" },
    })
  : undefined;

function fetchWithProxy(input: RequestInfo | URL, init?: RequestInit) {
  if (!proxyAgent) return fetch(input, init);
  const nextInit = init ? { ...init, dispatcher: proxyAgent } : { dispatcher: proxyAgent };
  return fetch(input, nextInit);
}

const RESPONSE_PAGE = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Moltbot Antigravity OAuth</title>
  </head>
  <body>
    <main>
      <h1>Authentication complete</h1>
      <p>You can return to the terminal.</p>
    </main>
  </body>
</html>`;

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("hex");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
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

function buildAuthUrl(params: { challenge: string; state: string }): string {
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", params.state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

function parseCallbackInput(
  input: string,
): { code: string; state: string } | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { error: "No input provided" };

  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code) return { error: "Missing 'code' parameter in URL" };
    if (!state) return { error: "Missing 'state' parameter in URL" };
    return { code, state };
  } catch {
    return { error: "Paste the full redirect URL (not just the code)." };
  }
}

async function startCallbackServer(params: { timeoutMs: number }) {
  const redirect = new URL(REDIRECT_URI);
  const port = redirect.port ? Number(redirect.port) : 51121;

  let settled = false;
  let resolveCallback: (url: URL) => void;
  let rejectCallback: (err: Error) => void;

  const callbackPromise = new Promise<URL>((resolve, reject) => {
    resolveCallback = (url) => {
      if (settled) return;
      settled = true;
      resolve(url);
    };
    rejectCallback = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
  });

  const timeout = setTimeout(() => {
    rejectCallback(new Error("Timed out waiting for OAuth callback"));
  }, params.timeoutMs);
  timeout.unref?.();

  const server = createServer((request, response) => {
    if (!request.url) {
      response.writeHead(400, { "Content-Type": "text/plain" });
      response.end("Missing URL");
      return;
    }

    const url = new URL(request.url, `${redirect.protocol}//${redirect.host}`);
    if (url.pathname !== redirect.pathname) {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("Not found");
      return;
    }

    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(RESPONSE_PAGE);
    resolveCallback(url);

    setImmediate(() => {
      server.close();
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("error", onError);
      reject(err);
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  return {
    waitForCallback: () => callbackPromise,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function exchangeCode(params: {
  code: string;
  verifier: string;
}): Promise<{ access: string; refresh: string; expires: number }> {
  const response = await fetchWithProxy(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: params.code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
      code_verifier: params.verifier,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed: ${text}`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const access = data.access_token?.trim();
  const refresh = data.refresh_token?.trim();
  const expiresIn = data.expires_in ?? 0;

  if (!access) throw new Error("Token exchange returned no access_token");
  if (!refresh) throw new Error("Token exchange returned no refresh_token");

  const expires = Date.now() + expiresIn * 1000 - 5 * 60 * 1000;
  return { access, refresh, expires };
}

async function fetchUserEmail(accessToken: string): Promise<string | undefined> {
  try {
    const response = await fetchWithProxy("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return undefined;
    const data = (await response.json()) as { email?: string };
    return data.email;
  } catch {
    return undefined;
  }
}

async function fetchProjectId(accessToken: string): Promise<string> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": "google-api-nodejs-client/9.15.1",
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": JSON.stringify({
      ideType: "IDE_UNSPECIFIED",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    }),
  };

  for (const endpoint of CODE_ASSIST_ENDPOINTS) {
    try {
      const response = await fetchWithProxy(`${endpoint}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          metadata: {
            ideType: "IDE_UNSPECIFIED",
            platform: "PLATFORM_UNSPECIFIED",
            pluginType: "GEMINI",
          },
        }),
      });

      if (!response.ok) continue;
      const data = (await response.json()) as {
        cloudaicompanionProject?: string | { id?: string };
      };

      if (typeof data.cloudaicompanionProject === "string") {
        return data.cloudaicompanionProject;
      }
      if (
        data.cloudaicompanionProject &&
        typeof data.cloudaicompanionProject === "object" &&
        data.cloudaicompanionProject.id
      ) {
        return data.cloudaicompanionProject.id;
      }
    } catch {
      // ignore
    }
  }

  return DEFAULT_PROJECT_ID;
}

async function loginAntigravity(params: {
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
  prompt: (message: string) => Promise<string>;
  note: (message: string, title?: string) => Promise<void>;
  log: (message: string) => void;
  progress: { update: (msg: string) => void; stop: (msg?: string) => void };
}): Promise<{
  access: string;
  refresh: string;
  expires: number;
  email?: string;
  projectId: string;
}> {
  const { verifier, challenge } = generatePkce();
  const state = randomBytes(16).toString("hex");
  const authUrl = buildAuthUrl({ challenge, state });

  let callbackServer: Awaited<ReturnType<typeof startCallbackServer>> | null = null;
  const needsManual = shouldUseManualOAuthFlow(params.isRemote);
  if (!needsManual) {
    try {
      callbackServer = await startCallbackServer({ timeoutMs: 5 * 60 * 1000 });
    } catch {
      callbackServer = null;
    }
  }

  if (!callbackServer) {
    await params.note(
      [
        "Open the URL in your local browser.",
        "After signing in, copy the full redirect URL and paste it back here.",
        "",
        `Auth URL: ${authUrl}`,
        `Redirect URI: ${REDIRECT_URI}`,
      ].join("\n"),
      "Google Antigravity OAuth",
    );
    // Output raw URL below the box for easy copying (fixes #1772)
    params.log("");
    params.log("Copy this URL:");
    params.log(authUrl);
    params.log("");
  }

  if (!needsManual) {
    params.progress.update("Opening Google sign-in…");
    try {
      await params.openUrl(authUrl);
    } catch {
      // ignore
    }
  }

  let code = "";
  let returnedState = "";

  if (callbackServer) {
    params.progress.update("Waiting for OAuth callback…");
    const callback = await callbackServer.waitForCallback();
    code = callback.searchParams.get("code") ?? "";
    returnedState = callback.searchParams.get("state") ?? "";
    await callbackServer.close();
  } else {
    params.progress.update("Waiting for redirect URL…");
    const input = await params.prompt("Paste the redirect URL: ");
    const parsed = parseCallbackInput(input);
    if ("error" in parsed) throw new Error(parsed.error);
    code = parsed.code;
    returnedState = parsed.state;
  }

  if (!code) throw new Error("Missing OAuth code");
  if (returnedState !== state) {
    throw new Error("OAuth state mismatch. Please try again.");
  }

  params.progress.update("Exchanging code for tokens…");
  const tokens = await exchangeCode({ code, verifier });
  const email = await fetchUserEmail(tokens.access);
  const projectId = await fetchProjectId(tokens.access);

  params.progress.stop("Antigravity OAuth complete");
  return { ...tokens, email, projectId };
}

const antigravityPlugin = {
  id: "google-antigravity-auth",
  name: "Google Antigravity Auth",
  description: "OAuth flow for Google Antigravity (Cloud Code Assist)",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    api.registerProvider({
      id: "google-antigravity",
      label: "Google Antigravity",
      docsPath: "/providers/models",
      aliases: ["antigravity"],
      auth: [
        {
          id: "oauth",
          label: "Google OAuth",
          hint: "PKCE + localhost callback",
          kind: "oauth",
          run: async (ctx) => {
            const spin = ctx.prompter.progress("Starting Antigravity OAuth…");
            try {
              const result = await loginAntigravity({
                isRemote: ctx.isRemote,
                openUrl: ctx.openUrl,
                prompt: async (message) => String(await ctx.prompter.text({ message })),
                note: ctx.prompter.note,
                log: (message) => ctx.runtime.log(message),
                progress: spin,
              });

              const profileId = `google-antigravity:${result.email ?? "default"}`;
              return {
                profiles: [
                  {
                    profileId,
                    credential: {
                      type: "oauth",
                      provider: "google-antigravity",
                      access: result.access,
                      refresh: result.refresh,
                      expires: result.expires,
                      email: result.email,
                      projectId: result.projectId,
                    },
                  },
                ],
                configPatch: {
                  agents: {
                    defaults: {
                      models: {
                        [DEFAULT_MODEL]: {},
                      },
                    },
                  },
                },
                defaultModel: DEFAULT_MODEL,
                notes: [
                  "Antigravity uses Google Cloud project quotas.",
                  "Enable Gemini for Google Cloud on your project if requests fail.",
                ],
              };
            } catch (err) {
              spin.stop("Antigravity OAuth failed");
              throw err;
            }
          },
        },
      ],
    });
  },
};

export default antigravityPlugin;
