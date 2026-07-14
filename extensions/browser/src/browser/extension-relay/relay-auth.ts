/**
 * Extension relay auth material.
 *
 * The relay authenticates the loopback link between OpenClaw and the paired
 * Chrome extension with a host-local secret. It is persisted per machine in the
 * credentials dir, so the gateway host and every browser node host each own an
 * independent token — the extension pairs with whichever machine runs its
 * Chrome, and no gateway credential ever has to travel to a node.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveOAuthDir } from "openclaw/plugin-sdk/state-paths";

const RELAY_SECRET_FILE = "browser-extension-relay.secret";

// resolveOAuthDir returns `${stateDir}/credentials`, the shared credentials dir.
function resolveExtensionRelaySecretPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveOAuthDir(env), RELAY_SECRET_FILE);
}

function normalizeToken(raw: string): string | null {
  const value = raw.trim();
  return /^[0-9a-f]{64}$/.test(value) ? value : null;
}

/** Read the host-local relay token, or null when it has not been created yet. */
export function readExtensionRelayToken(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    return normalizeToken(fs.readFileSync(resolveExtensionRelaySecretPath(env), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Read the host-local relay token, creating it on first use. Called from relay
 * startup and `openclaw browser extension pair` — both run on the machine that
 * hosts the browser, so they resolve the same per-host secret.
 *
 * The create is atomic (O_CREAT|O_EXCL): the gateway service and the pair CLI
 * are separate processes that can race on a fresh host, and a non-atomic
 * read-then-write would let each mint a distinct token (relay expects one, the
 * printed pairing string carries the other → 401). On EEXIST the winner's token
 * is re-read.
 */
export function ensureExtensionRelayToken(env: NodeJS.ProcessEnv = process.env): string {
  const secretPath = resolveExtensionRelaySecretPath(env);
  const existing = readExtensionRelayToken(env);
  if (existing) {
    return existing;
  }
  const token = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(secretPath, `${token}\n`, { mode: 0o600, flag: "wx" });
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
    // Another process created it first; adopt its token.
    const winner = readExtensionRelayToken(env);
    if (!winner) {
      throw new Error("extension relay secret exists but is unreadable/malformed", { cause: err });
    }
    return winner;
  }
}

/** Resolve the relay token for config (read-only; null until first ensured). */
export function resolveExtensionRelayToken(env: NodeJS.ProcessEnv = process.env): string | null {
  return readExtensionRelayToken(env);
}
