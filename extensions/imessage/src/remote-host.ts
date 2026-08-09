import fs from "node:fs/promises";
import { normalizeScpRemoteHost } from "openclaw/plugin-sdk/host-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { expandIMessageUserPath } from "./cli-path.js";

// CLI installation and wrapper contents are process-stable channel metadata.
// Cache negative results too so every runtime surface makes one locality decision.
const ambiguousSshWrapper = Symbol("ambiguous-ssh-wrapper");
const detectedRemoteHosts = new Map<string, string | null | typeof ambiguousSshWrapper>();
const remoteHostLookups = new Map<string, Promise<string | undefined>>();

function cacheKey(cliPath: string): string {
  return expandIMessageUserPath(cliPath.trim() || "imsg");
}

function unwrapExecutableToken(token: string): string | undefined {
  const first = token[0];
  if ((first === '"' || first === "'") && token.at(-1) === first) {
    return token.slice(1, -1);
  }
  return token.includes('"') || token.includes("'") ? undefined : token;
}

function isExecutable(token: string, name: "ssh" | "imsg"): boolean {
  const executable = unwrapExecutableToken(token);
  if (!executable) {
    return false;
  }
  return (
    executable === name || (executable.startsWith("/") && executable.split("/").at(-1) === name)
  );
}

function looksLikeSshWrapper(content: string): boolean {
  // This is intentionally a conservative token scan, not a shell parser. Any
  // SSH executable outside the exact one-line grammar requires explicit config.
  const tokens = content.match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s"'`;&|()<>\\]+/g) ?? [];
  return tokens.some((token) => isExecutable(token, "ssh"));
}

function parseRemoteHost(content: string): string | null | undefined {
  // Wrapper discovery recognizes only the documented transparent shape. Treat
  // every option-rich shell command as ambiguous so staging never targets a proxy.
  if (/\\\r?\n/.test(content)) {
    return looksLikeSshWrapper(content) ? null : undefined;
  }
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines[0]?.startsWith("#!")) {
    lines.shift();
  }
  if (lines.length !== 1) {
    return looksLikeSshWrapper(content) ? null : undefined;
  }
  const command = lines[0];
  const match = command?.match(
    /^exec\s+((?:"[^"]+"|'[^']+'|[^\s"']+))\s+(?:-T\s+)?([^\s]+)\s+((?:"[^"]+"|'[^']+'|[^\s"']+))\s+"\$@"$/,
  );
  const sshExecutable = match?.[1];
  const destination = match?.[2];
  const imsgExecutable = match?.[3];
  if (
    !sshExecutable ||
    !destination ||
    !imsgExecutable ||
    !isExecutable(sshExecutable, "ssh") ||
    !isExecutable(imsgExecutable, "imsg")
  ) {
    return looksLikeSshWrapper(content) ? null : undefined;
  }
  return normalizeScpRemoteHost(destination) ?? null;
}

function throwAmbiguousSshWrapper(): never {
  throw new Error(
    "iMessage SSH cliPath wrapper is not the simple transparent form; configure channels.imessage.remoteHost explicitly.",
  );
}

export function getCachedIMessageRemoteHost(params: {
  cliPath: string;
  remoteHost?: string;
}): string | undefined {
  const configured = normalizeScpRemoteHost(params.remoteHost);
  if (configured) {
    return configured;
  }
  const cached = detectedRemoteHosts.get(cacheKey(params.cliPath));
  return typeof cached === "string" ? cached : undefined;
}

export async function resolveIMessageRemoteHost(params: {
  cliPath: string;
  remoteHost?: string;
}): Promise<string | undefined> {
  const configured = normalizeScpRemoteHost(params.remoteHost);
  if (configured) {
    return configured;
  }
  if (params.remoteHost?.trim()) {
    logVerbose("imessage: ignoring unsafe configured remoteHost value");
  }

  const key = cacheKey(params.cliPath);
  if (detectedRemoteHosts.has(key)) {
    const cached = detectedRemoteHosts.get(key);
    if (cached === ambiguousSshWrapper) {
      throwAmbiguousSshWrapper();
    }
    return cached ?? undefined;
  }
  if (!key.includes("/") && !key.includes("\\")) {
    detectedRemoteHosts.set(key, null);
    return undefined;
  }
  const pending = remoteHostLookups.get(key);
  if (pending) {
    return await pending;
  }
  const lookup = (async () => {
    let detected: string | null | undefined;
    try {
      detected = parseRemoteHost(await fs.readFile(key, "utf8"));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        logVerbose(`imessage: failed to inspect cliPath ${params.cliPath}: ${String(error)}`);
      }
    }
    if (detected === null) {
      detectedRemoteHosts.set(key, ambiguousSshWrapper);
      throwAmbiguousSshWrapper();
    }
    const normalized = normalizeScpRemoteHost(detected);
    if (detected && !normalized) {
      logVerbose("imessage: ignoring unsafe auto-detected remoteHost from cliPath");
    } else if (normalized) {
      logVerbose(`imessage: detected remoteHost=${normalized} from cliPath`);
    }
    detectedRemoteHosts.set(key, normalized ?? null);
    return normalized;
  })().finally(() => remoteHostLookups.delete(key));
  remoteHostLookups.set(key, lookup);
  return await lookup;
}
