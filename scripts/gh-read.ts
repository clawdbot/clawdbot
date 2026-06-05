// Gh Read script supports OpenClaw repository automation.
import { execFileSync, spawnSync } from "node:child_process";
import { createPrivateKey, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readBoundedResponseText } from "./lib/bounded-response.ts";
import { parseStrictIntegerOption } from "./lib/dev-tooling-safety.ts";

const APP_ID_ENV = "OPENCLAW_GH_READ_APP_ID";
const KEY_FILE_ENV = "OPENCLAW_GH_READ_PRIVATE_KEY_FILE";
const INSTALLATION_ID_ENV = "OPENCLAW_GH_READ_INSTALLATION_ID";
const PERMISSIONS_ENV = "OPENCLAW_GH_READ_PERMISSIONS";
const API_VERSION = "2022-11-28";
const DEFAULT_GITHUB_FETCH_TIMEOUT_MS = 30_000;
const GITHUB_ERROR_BODY_MAX_CHARS = 4096;
const GITHUB_JSON_BODY_MAX_BYTES = 1024 * 1024;
const DEFAULT_READ_PERMISSION_KEYS = [
  "actions",
  "checks",
  "contents",
  "issues",
  "metadata",
  "pull_requests",
  "statuses",
] as const;

type GrantedPermissionLevel = "read" | "write" | "admin" | null | undefined;
type RequestedPermissionLevel = "read" | "write";
type GrantedPermissions = Record<string, GrantedPermissionLevel>;
type RequestedPermissions = Record<string, RequestedPermissionLevel>;

type InstallationResponse = {
  id: number;
  permissions?: GrantedPermissions;
};

type AccessTokenResponse = {
  token: string;
};

type GitHubJsonOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export function parseRepoArg(args: string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-R" || arg === "--repo") {
      return normalizeRepo(args[i + 1] ?? null);
    }
    if (arg.startsWith("--repo=")) {
      return normalizeRepo(arg.slice("--repo=".length));
    }
    if (arg.startsWith("-R") && arg.length > 2) {
      return normalizeRepo(arg.slice(2));
    }
  }
  return null;
}

export function normalizeRepo(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const withoutProtocol = trimmed.replace(/^[a-z]+:\/\//i, "");
  const withoutHost = withoutProtocol.replace(/^(?:[^@/]+@)?github\.com[:/]/i, "");
  const normalized = withoutHost.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length < 2) {
    return null;
  }

  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

export function parsePermissionKeys(raw: string | null | undefined): string[] {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return [...DEFAULT_READ_PERMISSION_KEYS];
  }

  return trimmed
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function buildReadPermissions(
  grantedPermissions: GrantedPermissions | null | undefined,
  requestedKeys: readonly string[],
): RequestedPermissions {
  const permissions: RequestedPermissions = {};
  for (const key of requestedKeys) {
    const granted = grantedPermissions?.[key];
    if (granted === "read" || granted === "write") {
      permissions[key] = "read";
    }
  }
  return permissions;
}

export function resolveGitHubFetchTimeoutMs(raw = process.env.OPENCLAW_GH_READ_FETCH_TIMEOUT_MS) {
  return parseStrictIntegerOption({
    fallback: DEFAULT_GITHUB_FETCH_TIMEOUT_MS,
    label: "OPENCLAW_GH_READ_FETCH_TIMEOUT_MS",
    min: 1,
    raw,
  });
}

function isMainModule() {
  const entry = process.argv[1];
  return entry ? import.meta.url === pathToFileURL(entry).href : false;
}

function fail(message: string): never {
  console.error(`gh-read: ${message}`);
  process.exit(1);
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    fail(`missing ${name}`);
  }
  return value;
}

function resolveRepo(args: string[]): string | null {
  const fromArgs = parseRepoArg(args);
  if (fromArgs) {
    return fromArgs;
  }

  const fromEnv = normalizeRepo(process.env.GH_REPO);
  if (fromEnv) {
    return fromEnv;
  }

  try {
    const remote = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return normalizeRepo(remote);
  } catch {
    return null;
  }
}

function base64UrlEncode(value: string | Uint8Array) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createAppJwt(appId: string, privateKeyPem: string) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(createPrivateKey(privateKeyPem));
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

async function withGitHubFetchTimeout<T>(
  label: string,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(`${label} exceeded timeout of ${timeoutMs}ms`);
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function readBoundedGitHubErrorText(
  response: Response,
  maxChars = GITHUB_ERROR_BODY_MAX_CHARS,
): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let truncated = false;

  try {
    while (text.length <= maxChars) {
      const { done, value } = await reader.read();
      if (done) {
        text += decoder.decode();
        break;
      }

      text += decoder.decode(value, { stream: true });
      if (text.length > maxChars) {
        text = text.slice(0, maxChars);
        truncated = true;
        break;
      }
    }
  } finally {
    if (truncated) {
      await reader.cancel().catch(() => undefined);
    } else {
      reader.releaseLock();
    }
  }

  return truncated ? `${text}\n[truncated]` : text;
}

export async function readBoundedGitHubJson<T>(
  response: Response,
  maxBytes = GITHUB_JSON_BODY_MAX_BYTES,
): Promise<T> {
  const text = await readBoundedResponseText(response, "GitHub API", maxBytes, {
    createTooLargeError: (message) =>
      Object.assign(new Error(message), {
        code: "ETOOBIG",
      }),
  });
  return JSON.parse(text) as T;
}

export async function githubJson<T>(
  path: string,
  bearerToken: string,
  init?: {
    method?: "GET" | "POST";
    body?: unknown;
  },
  options: GitHubJsonOptions = {},
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? resolveGitHubFetchTimeoutMs();
  return await withGitHubFetchTimeout(
    `GitHub API ${init?.method ?? "GET"} ${path}`,
    timeoutMs,
    async (signal) => {
      const response = await fetchImpl(`https://api.github.com${path}`, {
        method: init?.method ?? "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${bearerToken}`,
          "Content-Type": "application/json",
          "User-Agent": "openclaw-gh-read",
          "X-GitHub-Api-Version": API_VERSION,
        },
        body: init?.body === undefined ? undefined : JSON.stringify(init.body),
        signal,
      });

      if (!response.ok) {
        const text = await readBoundedGitHubErrorText(response);
        fail(`${init?.method ?? "GET"} ${path} failed (${response.status}): ${text}`);
      }

      return await readBoundedGitHubJson<T>(response);
    },
  );
}

async function resolveInstallation(
  appJwt: string,
  repo: string | null,
): Promise<InstallationResponse> {
  const installationId = process.env[INSTALLATION_ID_ENV]?.trim();
  if (repo) {
    return githubJson<InstallationResponse>(`/repos/${repo}/installation`, appJwt);
  }
  if (installationId) {
    return githubJson<InstallationResponse>(`/app/installations/${installationId}`, appJwt);
  }
  fail(
    `missing repo context; pass -R owner/repo, set GH_REPO, or set ${INSTALLATION_ID_ENV} for a direct installation lookup`,
  );
  throw new Error("unreachable");
}

async function createInstallationToken(
  appJwt: string,
  installation: InstallationResponse,
  repo: string | null,
): Promise<string> {
  const repoName = repo?.split("/")[1] ?? null;
  const requestedPermissionKeys = parsePermissionKeys(process.env[PERMISSIONS_ENV]);
  const permissions = buildReadPermissions(installation.permissions, requestedPermissionKeys);
  const body: {
    repositories?: string[];
    permissions?: RequestedPermissions;
  } = {};

  if (repoName) {
    body.repositories = [repoName];
  }
  if (Object.keys(permissions).length > 0) {
    body.permissions = permissions;
  }

  const tokenResponse = await githubJson<AccessTokenResponse>(
    `/app/installations/${installation.id}/access_tokens`,
    appJwt,
    { method: "POST", body },
  );
  return tokenResponse.token;
}

async function main() {
  if (process.argv.length <= 2) {
    fail(
      "usage: scripts/gh-read <gh args...>\nset OPENCLAW_GH_READ_APP_ID and OPENCLAW_GH_READ_PRIVATE_KEY_FILE first",
    );
  }

  const ghArgs = process.argv.slice(2);
  const appId = readRequiredEnv(APP_ID_ENV);
  const privateKeyPath = readRequiredEnv(KEY_FILE_ENV);
  const privateKeyPem = readFileSync(privateKeyPath, "utf8");
  const repo = resolveRepo(ghArgs);
  const appJwt = createAppJwt(appId, privateKeyPem);
  const installation = await resolveInstallation(appJwt, repo);
  const token = await createInstallationToken(appJwt, installation, repo);
  const child = spawnSync("gh", ghArgs, {
    stdio: "inherit",
    env: {
      ...process.env,
      GH_TOKEN: token,
      GITHUB_TOKEN: token,
    },
  });

  if (child.error) {
    fail(child.error.message);
  }

  process.exit(child.status ?? 1);
}

if (isMainModule()) {
  await main();
}
