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
import { createSecretFileAtomic, tryReadSecretFileSync } from "openclaw/plugin-sdk/secret-file";
import { resolveOAuthDir } from "openclaw/plugin-sdk/state-paths";
import { extractErrorCode } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("browser").child("extension-relay");

const RELAY_SECRET_FILE = "browser-extension-relay.secret";
const RELAY_SECRET_REREAD_ATTEMPTS = 50;
const RELAY_SECRET_REREAD_DELAY_MS = 10;
const PRIVATE_SECRET_FILE_MODE = 0o600;
// Keep the existing secret-file reader's byte limit when reading our pinned descriptor.
const MAX_RELAY_SECRET_BYTES = 16 * 1024;

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
  const secretPath = resolveExtensionRelaySecretPath(env);
  if (process.platform === "win32") {
    return normalizeToken(
      tryReadSecretFileSync(secretPath, "browser extension relay secret", {
        rejectSymlink: true,
      }) ?? "",
    );
  }
  const uid = process.getuid?.();
  let fd: number | undefined;
  let raw: string;
  try {
    const before = fs.lstatSync(secretPath);
    if (!before.isFile() || before.uid !== uid || before.nlink !== 1) {
      return null;
    }
    // Permission checks, tightening, and reading must concern the same inode.
    // NONBLOCK also prevents a file-to-pipe swap from hanging the native host.
    fd = fs.openSync(
      secretPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const sameFile = (stat: fs.Stats) =>
      stat.isFile() &&
      stat.uid === uid &&
      stat.nlink === 1 &&
      stat.dev === before.dev &&
      stat.ino === before.ino;
    const opened = fs.fstatSync(fd);
    if (!sameFile(opened) || !sameFile(fs.lstatSync(secretPath))) {
      return null;
    }
    if ((opened.mode & 0o077) !== 0) {
      fs.fchmodSync(fd, PRIVATE_SECRET_FILE_MODE);
      log.warn("tightened extension relay secret permissions to 0600");
    }
    const buffer = Buffer.alloc(MAX_RELAY_SECRET_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) {
        break;
      }
      length += count;
    }
    const after = fs.fstatSync(fd);
    if (
      length > MAX_RELAY_SECRET_BYTES ||
      !sameFile(after) ||
      (after.mode & 0o077) !== 0 ||
      !sameFile(fs.lstatSync(secretPath))
    ) {
      return null;
    }
    raw = buffer.subarray(0, length).toString("utf8");
  } catch (error) {
    if (extractErrorCode(error) !== "ENOENT") {
      log.warn("ignoring extension relay secret: file changed or could not be read privately");
    }
    return null;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
  // An exclusive first writer can still be filling an empty file. Preserve the
  // reader's throwing outcome so ensure retries adoption instead of creating.
  if (!raw.trim()) {
    throw new Error("extension relay secret is empty");
  }
  return normalizeToken(raw);
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
  let lastError: unknown;
  for (let attempt = 0; attempt < RELAY_SECRET_REREAD_ATTEMPTS; attempt += 1) {
    let canCreate = false;
    try {
      const winner = readExtensionRelayToken(env);
      if (winner) {
        return winner;
      }
      canCreate = attempt === 0;
    } catch (err) {
      // An exclusive writer can expose an empty final file before ensure starts;
      // retry adoption without invoking the stricter credential creation guards.
      lastError = err;
    }
    if (canCreate) {
      const token = crypto.randomBytes(32).toString("hex");
      try {
        await createSecretFileAtomic({
          rootDir: path.dirname(secretPath),
          filePath: secretPath,
          content: `${token}\n`,
        });
        return token;
      } catch (err) {
        if (extractErrorCode(err) !== "secret-exists") {
          throw err;
        }
        lastError = err;
      }
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, RELAY_SECRET_REREAD_DELAY_MS);
    });
  }
  throw new Error("extension relay secret exists but is unreadable/malformed", {
    cause: lastError,
  });
}
