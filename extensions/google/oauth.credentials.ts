// Google plugin module implements oauth.credentials behavior.
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import type { Dirent } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { lowercasePreservingWhitespace } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CLIENT_ID_KEYS, CLIENT_SECRET_KEYS } from "./oauth.shared.js";

type CredentialFs = {
  existsSync: (path: Parameters<typeof existsSync>[0]) => ReturnType<typeof existsSync>;
  readFileSync: (path: Parameters<typeof readFileSync>[0], encoding: "utf8") => string;
  realpathSync: (path: Parameters<typeof realpathSync>[0]) => string;
  readdirSync: (
    path: Parameters<typeof readdirSync>[0],
    options: { withFileTypes: true },
  ) => Dirent[];
};

const defaultFs: CredentialFs = {
  existsSync,
  readFileSync,
  realpathSync,
  readdirSync,
};

const OAUTH_CREDENTIALS_TEST_API_KEY = Symbol.for("openclaw.google.oauthCredentialsTestApi");

let credentialFs: CredentialFs = defaultFs;
const GEMINI_CLI_TREE_SEARCH_DEPTH = 10;

type GeminiCliCredentialExtractDiagnostics = {
  searchedPaths: string[];
  recursiveSearchRoots: string[];
  parseFailures: string[];
  readErrors: string[];
};

function resolveEnv(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

let cachedGeminiCliCredentials: { clientId: string; clientSecret: string } | null = null;
let geminiCliCredentialExtractError: string | null = null;

function clearCredentialsCache(): void {
  cachedGeminiCliCredentials = null;
  geminiCliCredentialExtractError = null;
}

function setOAuthCredentialsFsForTest(overrides?: Partial<CredentialFs>): void {
  credentialFs = overrides ? { ...defaultFs, ...overrides } : defaultFs;
}

function extractGeminiCliCredentials(): { clientId: string; clientSecret: string } | null {
  if (cachedGeminiCliCredentials) {
    return cachedGeminiCliCredentials;
  }

  geminiCliCredentialExtractError = null;
  const diagnostics: GeminiCliCredentialExtractDiagnostics = {
    searchedPaths: [],
    recursiveSearchRoots: [],
    parseFailures: [],
    readErrors: [],
  };

  try {
    const geminiPath = findInPath("gemini");
    if (!geminiPath) {
      geminiCliCredentialExtractError =
        "Gemini CLI binary was not found in PATH during OAuth credential extraction.";
      return null;
    }

    const resolvedPath = credentialFs.realpathSync(geminiPath);
    const geminiCliDirs = resolveGeminiCliDirs(geminiPath, resolvedPath);

    for (const geminiCliDir of geminiCliDirs) {
      const directCredentials = readGeminiCliCredentialsFromKnownPaths(geminiCliDir, diagnostics);
      if (directCredentials) {
        cachedGeminiCliCredentials = directCredentials;
        return directCredentials;
      }

      const bundledCredentials = readGeminiCliCredentialsFromBundle(geminiCliDir, diagnostics);
      if (bundledCredentials) {
        cachedGeminiCliCredentials = bundledCredentials;
        return bundledCredentials;
      }

      diagnostics.recursiveSearchRoots.push(geminiCliDir);
      const discoveredCredentials = findGeminiCliCredentialsInTree(
        geminiCliDir,
        GEMINI_CLI_TREE_SEARCH_DEPTH,
        diagnostics,
      );
      if (discoveredCredentials) {
        cachedGeminiCliCredentials = discoveredCredentials;
        return discoveredCredentials;
      }
    }
    geminiCliCredentialExtractError = formatGeminiCliCredentialExtractError({
      geminiPath,
      resolvedPath,
      diagnostics,
    });
  } catch (error) {
    geminiCliCredentialExtractError = `Unexpected error while extracting Gemini CLI OAuth credentials: ${formatError(error)}`;
  }
  return null;
}

function formatGeminiCliCredentialExtractError({
  geminiPath,
  resolvedPath,
  diagnostics,
}: {
  geminiPath: string;
  resolvedPath: string;
  diagnostics: GeminiCliCredentialExtractDiagnostics;
}): string {
  const prefix = [
    "Found Gemini CLI in PATH, but could not extract OAuth credentials.",
    `geminiPath=${geminiPath}`,
    `resolvedPath=${resolvedPath}`,
  ];

  if (diagnostics.parseFailures.length > 0) {
    return [
      ...prefix,
      "Candidate credential files did not contain a parseable OAuth client id/secret.",
      `candidates=${diagnostics.parseFailures.join(", ")}`,
    ].join(" ");
  }

  if (diagnostics.readErrors.length > 0) {
    return [
      ...prefix,
      "Unexpected errors occurred while reading candidate credential files/directories.",
      `errors=${diagnostics.readErrors.join(", ")}`,
    ].join(" ");
  }

  return [
    ...prefix,
    "Could not locate oauth2.js or bundled credential source.",
    `searched=${diagnostics.searchedPaths.join(", ") || "(none)"}`,
    `recursiveSearchRoots=${diagnostics.recursiveSearchRoots.join(", ") || "(none)"}`,
    `recursiveSearchDepth=${GEMINI_CLI_TREE_SEARCH_DEPTH}`,
  ].join(" ");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveGeminiCliDirs(geminiPath: string, resolvedPath: string): string[] {
  const binDir = dirname(geminiPath);
  const candidates = [
    dirname(dirname(resolvedPath)),
    join(dirname(resolvedPath), "node_modules", "@google", "gemini-cli"),
    join(binDir, "node_modules", "@google", "gemini-cli"),
    join(dirname(binDir), "node_modules", "@google", "gemini-cli"),
    join(dirname(binDir), "lib", "node_modules", "@google", "gemini-cli"),
  ];

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    for (const searchDir of resolveGeminiCliSearchDirs(candidate)) {
      const key =
        process.platform === "win32"
          ? lowercasePreservingWhitespace(searchDir.replace(/\\/g, "/"))
          : searchDir;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push(searchDir);
    }
  }
  return deduped;
}

function resolveGeminiCliSearchDirs(candidate: string): string[] {
  const searchDirs = [
    candidate,
    join(candidate, "node_modules", "@google", "gemini-cli"),
    join(candidate, "lib", "node_modules", "@google", "gemini-cli"),
  ];
  return searchDirs.filter(looksLikeGeminiCliDir);
}

function looksLikeGeminiCliDir(candidate: string): boolean {
  return (
    credentialFs.existsSync(join(candidate, "package.json")) ||
    credentialFs.existsSync(join(candidate, "node_modules", "@google", "gemini-cli-core"))
  );
}

function findInPath(name: string): string | null {
  const exts = process.platform === "win32" ? [".cmd", ".bat", ".exe", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const ext of exts) {
      const path = join(dir, name + ext);
      if (credentialFs.existsSync(path)) {
        return path;
      }
    }
  }
  return null;
}

function readGeminiCliCredentialsFile(
  path: string,
  diagnostics: GeminiCliCredentialExtractDiagnostics,
): { clientId: string; clientSecret: string } | null {
  try {
    const credentials = parseGeminiCliCredentials(credentialFs.readFileSync(path, "utf8"));
    if (!credentials) {
      diagnostics.parseFailures.push(path);
    }
    return credentials;
  } catch (error) {
    diagnostics.readErrors.push(`${path}: ${formatError(error)}`);
    return null;
  }
}

function parseGeminiCliCredentials(
  content: string,
): { clientId: string; clientSecret: string } | null {
  const clientId =
    content.match(/OAUTH_CLIENT_ID\s*=\s*["']([^"']+)["']/)?.[1] ??
    content.match(/(\d+-[a-z0-9]+\.apps\.googleusercontent\.com)/)?.[1];
  const clientSecret =
    content.match(/OAUTH_CLIENT_SECRET\s*=\s*["']([^"']+)["']/)?.[1] ??
    content.match(/(GOCSPX-[A-Za-z0-9_-]+)/)?.[1];
  if (!clientId || !clientSecret) {
    return null;
  }
  return { clientId, clientSecret };
}

function readGeminiCliCredentialsFromKnownPaths(
  geminiCliDir: string,
  diagnostics: GeminiCliCredentialExtractDiagnostics,
): { clientId: string; clientSecret: string } | null {
  const searchPaths = [
    join(
      geminiCliDir,
      "node_modules",
      "@google",
      "gemini-cli-core",
      "dist",
      "src",
      "code_assist",
      "oauth2.js",
    ),
    join(
      geminiCliDir,
      "node_modules",
      "@google",
      "gemini-cli-core",
      "dist",
      "code_assist",
      "oauth2.js",
    ),
  ];
  diagnostics.searchedPaths.push(...searchPaths);

  for (const path of searchPaths) {
    if (!credentialFs.existsSync(path)) {
      continue;
    }
    const credentials = readGeminiCliCredentialsFile(path, diagnostics);
    if (credentials) {
      return credentials;
    }
  }

  return null;
}

function readGeminiCliCredentialsFromBundle(
  geminiCliDir: string,
  diagnostics: GeminiCliCredentialExtractDiagnostics,
): { clientId: string; clientSecret: string } | null {
  const bundleDir = join(geminiCliDir, "bundle");
  if (!credentialFs.existsSync(bundleDir)) {
    return null;
  }

  try {
    for (const entry of credentialFs.readdirSync(bundleDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".js")) {
        continue;
      }
      const credentials = readGeminiCliCredentialsFile(join(bundleDir, entry.name), diagnostics);
      if (credentials) {
        return credentials;
      }
    }
  } catch (error) {
    diagnostics.readErrors.push(`${bundleDir}: ${formatError(error)}`);
    // Preserve the read error for diagnostics and fall back to the recursive search.
  }

  return null;
}

function findGeminiCliCredentialsInTree(
  dir: string,
  depth: number,
  diagnostics: GeminiCliCredentialExtractDiagnostics,
): { clientId: string; clientSecret: string } | null {
  if (depth <= 0) {
    return null;
  }
  try {
    for (const entry of credentialFs.readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isFile() && entry.name === "oauth2.js") {
        const credentials = readGeminiCliCredentialsFile(path, diagnostics);
        if (credentials) {
          return credentials;
        }
        continue;
      }
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        const found = findGeminiCliCredentialsInTree(path, depth - 1, diagnostics);
        if (found) {
          return found;
        }
      }
    }
  } catch (error) {
    diagnostics.readErrors.push(`${dir}: ${formatError(error)}`);
  }
  return null;
}

export function resolveOAuthClientConfig(): { clientId: string; clientSecret?: string } {
  const envClientId = resolveEnv(CLIENT_ID_KEYS);
  const envClientSecret = resolveEnv(CLIENT_SECRET_KEYS);
  if (envClientId) {
    return { clientId: envClientId, clientSecret: envClientSecret };
  }

  const extracted = extractGeminiCliCredentials();
  if (extracted) {
    return extracted;
  }

  const detail = geminiCliCredentialExtractError
    ? ` Details: ${geminiCliCredentialExtractError}`
    : "";
  throw new Error(
    `Gemini CLI not found. Install it first: brew install gemini-cli (or npm install -g @google/gemini-cli), or set GEMINI_CLI_OAUTH_CLIENT_ID.${detail}`,
  );
}

if (process.env.VITEST) {
  (globalThis as Record<PropertyKey, unknown>)[OAUTH_CREDENTIALS_TEST_API_KEY] = {
    clearCredentialsCache,
    setFs: setOAuthCredentialsFsForTest,
  };
}
