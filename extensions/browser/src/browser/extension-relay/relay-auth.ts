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
import path from "node:path";
import {
  createSecretFileAtomic,
  readSecretFile,
  tryReadSecretFileSync,
} from "openclaw/plugin-sdk/secret-file";
import { resolveOAuthDir } from "openclaw/plugin-sdk/state-paths";

const RELAY_SECRET_FILE = "browser-extension-relay.secret";
const RELAY_SECRET_REREAD_ATTEMPTS = 50;
const RELAY_SECRET_REREAD_DELAY_MS = 10;

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
  return normalizeToken(
    tryReadSecretFileSync(resolveExtensionRelaySecretPath(env), "browser extension relay secret") ??
      "",
  );
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
export async function ensureExtensionRelayToken(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const secretPath = resolveExtensionRelaySecretPath(env);
  const existing = readExtensionRelayToken(env);
  if (existing) {
    return existing;
  }
  const token = crypto.randomBytes(32).toString("hex");
  try {
    await createSecretFileAtomic({
      rootDir: path.dirname(secretPath),
      filePath: secretPath,
      content: `${token}\n`,
    });
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "secret-exists") {
      throw err;
    }
    // Another process created it first; its exclusive async write may still be
    // finishing after the final name appears, so adopt it with a bounded reread.
    for (let attempt = 0; attempt < RELAY_SECRET_REREAD_ATTEMPTS; attempt += 1) {
      try {
        const winner = normalizeToken(
          await readSecretFile(secretPath, "browser extension relay secret"),
        );
        if (winner) {
          return winner;
        }
      } catch {
        // Retry only inside the bounded first-writer handoff window.
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, RELAY_SECRET_REREAD_DELAY_MS);
      });
    }
    throw new Error("extension relay secret exists but is unreadable/malformed", { cause: err });
  }
}

/** Resolve the relay token for config (read-only; null until first ensured). */
export function resolveExtensionRelayToken(env: NodeJS.ProcessEnv = process.env): string | null {
  return readExtensionRelayToken(env);
}
