import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type GogTokenEntry = {
  account?: string;
  refreshToken: string;
};

const tokenCache = new Map<string, string>();

function resolveConfigDirs(): string[] {
  const dirs: string[] = [];
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) dirs.push(path.join(xdg, "gogcli"));
  const home = os.homedir();
  if (home) dirs.push(path.join(home, ".config", "gogcli"));
  if (process.platform === "darwin" && home) {
    dirs.push(path.join(home, "Library", "Application Support", "gogcli"));
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData) dirs.push(path.join(appData, "gogcli"));
  }
  return Array.from(new Set(dirs));
}

function extractDomain(account?: string | null): string | null {
  const value = account?.trim();
  if (!value) return null;
  const at = value.lastIndexOf("@");
  if (at === -1) return null;
  return value.slice(at + 1).toLowerCase();
}

export function resolveGogCredentialsFile(params: {
  gogClient?: string | null;
  gogAccount?: string | null;
}): string | null {
  const client = params.gogClient?.trim();
  const account = params.gogAccount?.trim();
  const domain = extractDomain(account);
  const dirs = resolveConfigDirs();
  const candidates: string[] = [];

  if (client) {
    for (const dir of dirs) {
      candidates.push(path.join(dir, `credentials-${client}.json`));
    }
  }
  if (domain) {
    for (const dir of dirs) {
      candidates.push(path.join(dir, `credentials-${domain}.json`));
    }
  }
  for (const dir of dirs) {
    candidates.push(path.join(dir, "credentials.json"));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function looksLikeRefreshToken(token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("ya29.")) return false;
  if (trimmed.startsWith("1//")) return true;
  return trimmed.length > 30;
}

function collectTokens(value: unknown, out: GogTokenEntry[]) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) collectTokens(entry, out);
    return;
  }
  const record = value as Record<string, unknown>;
  const refreshToken =
    typeof record.refresh_token === "string"
      ? record.refresh_token
      : typeof record.refreshToken === "string"
        ? record.refreshToken
        : undefined;
  if (refreshToken && looksLikeRefreshToken(refreshToken)) {
    const account =
      typeof record.email === "string"
        ? record.email
        : typeof record.account === "string"
          ? record.account
          : typeof record.user === "string"
            ? record.user
            : undefined;
    out.push({ account, refreshToken });
  }
  for (const entry of Object.values(record)) {
    collectTokens(entry, out);
  }
}

export function readGogRefreshTokenSync(params: {
  gogAccount?: string | null;
  gogClient?: string | null;
}): string | null {
  const cacheKey = `${params.gogClient ?? ""}:${params.gogAccount ?? ""}`;
  const cached = tokenCache.get(cacheKey);
  if (cached) return cached;

  let stdout = "";
  try {
    stdout = execFileSync("gog", ["auth", "tokens", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }

  const tokens: GogTokenEntry[] = [];
  collectTokens(parsed, tokens);
  if (tokens.length === 0) return null;

  const target = params.gogAccount?.trim().toLowerCase();
  if (target) {
    const match = tokens.find(
      (entry) => entry.account?.trim().toLowerCase() === target,
    );
    if (match?.refreshToken) {
      tokenCache.set(cacheKey, match.refreshToken);
      return match.refreshToken;
    }
  }

  if (tokens.length === 1) {
    const only = tokens[0]?.refreshToken;
    if (only) {
      tokenCache.set(cacheKey, only);
      return only;
    }
  }

  return null;
}
