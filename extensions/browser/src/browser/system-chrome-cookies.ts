/** macOS Chrome-family cookie database decryption and Playwright mapping. */
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { runCommandBuffered } from "openclaw/plugin-sdk/process-runtime";

export type SystemBrowser = "chrome" | "brave" | "edge" | "chromium";

type PlaywrightCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
};

type ChromeCookieRow = {
  host_key: string;
  top_frame_site_key: string;
  name: string;
  value: string;
  encrypted_value: Uint8Array;
  path: string;
  expires_utc: number | bigint;
  is_secure: number | bigint;
  is_httponly: number | bigint;
  has_expires: number | bigint;
  samesite: number | bigint;
};

type CookieImportCounts = {
  total: number;
  imported: number;
  failed: number;
  skipped: number;
};

type KeychainEntry = { service: string; account: string };
export type KeychainSecretReader = (entry: KeychainEntry, signal?: AbortSignal) => Promise<Buffer>;

const KEYCHAIN_ENTRIES: Record<SystemBrowser, KeychainEntry> = {
  chrome: { service: "Chrome Safe Storage", account: "Chrome" },
  brave: { service: "Brave Safe Storage", account: "Brave" },
  edge: { service: "Microsoft Edge Safe Storage", account: "Microsoft Edge" },
  chromium: { service: "Chromium Safe Storage", account: "Chromium" },
};

const CHROME_EPOCH_OFFSET_SECONDS = 11_644_473_600;
const V10_PREFIX = Buffer.from("v10", "ascii");
const COOKIE_QUERY = `
  SELECT host_key, top_frame_site_key, name, value, encrypted_value, path, expires_utc,
         is_secure, is_httponly, has_expires, samesite
  FROM cookies
`;

function isAsciiWhitespace(value: number): boolean {
  return (
    value === 0x09 ||
    value === 0x0a ||
    value === 0x0b ||
    value === 0x0c ||
    value === 0x0d ||
    value === 0x20
  );
}

/** Read the browser Safe Storage secret. The OS consent prompt is intentional. */
async function readKeychainSecret(entry: KeychainEntry, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  let stdout: Buffer;
  try {
    const result = await runCommandBuffered(
      ["security", "find-generic-password", "-w", "-s", entry.service, "-a", entry.account],
      {
        signal,
        maxOutputBytes: 1024 * 1024,
      },
    );
    if (result.termination !== "exit" || result.code !== 0) {
      throw result.error ?? new Error(`security exited with code ${result.code ?? "unknown"}`);
    }
    stdout = result.stdout;
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("Browser cookie import aborted.", { cause: signal.reason ?? error });
    }
    throw new Error(
      `could not read ${entry.service} from macOS Keychain; approve the prompt and retry`,
      { cause: error },
    );
  }
  const raw = stdout;
  let start = 0;
  let end = raw.length;
  while (start < end && isAsciiWhitespace(raw.readUInt8(start))) {
    start += 1;
  }
  while (end > start && isAsciiWhitespace(raw.readUInt8(end - 1))) {
    end -= 1;
  }
  const secret = Buffer.from(raw.subarray(start, end));
  raw.fill(0);
  if (secret.length === 0) {
    throw new Error(`macOS Keychain returned an empty ${entry.service} secret`);
  }
  return secret;
}

/** Convert Chromium's Windows-epoch microseconds to Unix seconds. */
function chromeFiletimeToUnixSeconds(value: number | bigint): number | undefined {
  if (typeof value === "bigint") {
    const seconds = value / 1_000_000n - BigInt(CHROME_EPOCH_OFFSET_SECONDS);
    return seconds > 0n && seconds <= 9_999_999_999n ? Number(seconds) : undefined;
  }
  if (!Number.isFinite(value) || value === 0) {
    return undefined;
  }
  const seconds = Math.floor(value / 1_000_000) - CHROME_EPOCH_OFFSET_SECONDS;
  return seconds > 0 && seconds <= 9_999_999_999 ? seconds : undefined;
}

/** Map Chrome SameSite storage values to Playwright's cookie contract. */
function mapChromeSameSite(
  value: number | bigint,
  secure: boolean,
): PlaywrightCookie["sameSite"] | undefined {
  const numericValue = Number(value);
  if (numericValue === 2) {
    return "Strict";
  }
  if (numericValue === 1) {
    return "Lax";
  }
  if (numericValue === 0 && secure) {
    return "None";
  }
  return undefined;
}

function decryptCookieValue(row: ChromeCookieRow, key: Buffer): string | undefined {
  const encrypted = Buffer.from(row.encrypted_value);
  if (encrypted.length === 0) {
    return row.value;
  }
  if (!encrypted.subarray(0, V10_PREFIX.length).equals(V10_PREFIX)) {
    return undefined;
  }
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  decipher.setAutoPadding(true);
  let plain = Buffer.concat([
    decipher.update(encrypted.subarray(V10_PREFIX.length)),
    decipher.final(),
  ]);
  const hostPrefix = crypto.createHash("sha256").update(row.host_key).digest();
  if (
    plain.length >= hostPrefix.length &&
    plain.subarray(0, hostPrefix.length).equals(hostPrefix)
  ) {
    plain = plain.subarray(hostPrefix.length);
  }
  return plain.toString("utf8");
}

function mapCookie(row: ChromeCookieRow, value: string): PlaywrightCookie {
  const secure = row.is_secure !== 0 && row.is_secure !== 0n;
  const isSession = row.has_expires === 0 || row.has_expires === 0n;
  const expires = isSession ? undefined : chromeFiletimeToUnixSeconds(row.expires_utc);
  const sameSite = mapChromeSameSite(row.samesite, secure);
  return {
    name: row.name,
    value,
    domain: row.host_key,
    path: row.path,
    httpOnly: row.is_httponly !== 0 && row.is_httponly !== 0n,
    secure,
    ...(expires === undefined ? {} : { expires }),
    ...(sameSite === undefined ? {} : { sameSite }),
  };
}

function matchesDomain(hostKey: string, domains: readonly string[] | undefined): boolean {
  if (!domains?.length) {
    return true;
  }
  const host = hostKey.replace(/^\./, "").toLowerCase();
  return domains.some((candidate) => {
    const domain = candidate.trim().replace(/^\./, "").toLowerCase();
    return domain.length > 0 && (host === domain || host.endsWith(`.${domain}`));
  });
}

/** Decrypt and map cookie rows without exposing any cookie values in the result metadata. */
async function decryptChromeCookieRows(params: {
  browser: SystemBrowser;
  rows: readonly ChromeCookieRow[];
  domains?: readonly string[];
  readSecret?: KeychainSecretReader;
  signal?: AbortSignal;
}): Promise<{ cookies: PlaywrightCookie[]; counts: CookieImportCounts; domains: string[] }> {
  const counts: CookieImportCounts = {
    total: params.rows.length,
    imported: 0,
    failed: 0,
    skipped: 0,
  };
  const selected = params.rows.filter((row) => {
    if (!matchesDomain(row.host_key, params.domains)) {
      counts.skipped += 1;
      return false;
    }
    if (row.top_frame_site_key.trim().length > 0) {
      // Never weaken a partitioned cookie into an ordinary cross-site cookie.
      counts.skipped += 1;
      return false;
    }
    return true;
  });
  if (selected.length === 0) {
    return { cookies: [], counts, domains: [] };
  }

  const readSecret = params.readSecret ?? readKeychainSecret;
  const secret = await readSecret(KEYCHAIN_ENTRIES[params.browser], params.signal);
  let key: Buffer | undefined;
  const cookies: PlaywrightCookie[] = [];
  try {
    const decryptionKey = crypto.pbkdf2Sync(secret, "saltysalt", 1003, 16, "sha1");
    key = decryptionKey;
    for (const row of selected) {
      params.signal?.throwIfAborted();
      const encrypted = Buffer.from(row.encrypted_value);
      if (encrypted.length > 0 && !encrypted.subarray(0, 3).equals(V10_PREFIX)) {
        counts.skipped += 1;
        continue;
      }
      try {
        const value = decryptCookieValue(row, decryptionKey);
        if (value === undefined) {
          counts.skipped += 1;
          continue;
        }
        cookies.push(mapCookie(row, value));
      } catch {
        counts.failed += 1;
      }
    }
  } finally {
    secret.fill(0);
    key?.fill(0);
  }
  counts.imported = cookies.length;
  const importedDomains = [...new Set(cookies.map((cookie) => cookie.domain))].toSorted();
  return { cookies, counts, domains: importedDomains };
}

/** Read cookies from a copied Chromium SQLite database and decrypt them. */
export async function readChromeCookiesDatabase(params: {
  browser: SystemBrowser;
  databasePath: string;
  domains?: readonly string[];
  readSecret?: KeychainSecretReader;
  signal?: AbortSignal;
}) {
  const database = new DatabaseSync(params.databasePath, { readOnly: true });
  try {
    const statement = database.prepare(COOKIE_QUERY);
    statement.setReadBigInts(true);
    const rows = statement.all() as unknown as ChromeCookieRow[];
    return await decryptChromeCookieRows({
      browser: params.browser,
      rows,
      domains: params.domains,
      readSecret: params.readSecret,
      signal: params.signal,
    });
  } finally {
    database.close();
  }
}
