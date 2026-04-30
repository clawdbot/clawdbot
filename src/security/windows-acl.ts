import os from "node:os";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runExec } from "../process/exec.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

const log = createSubsystemLogger("security/windows-acl");

export type ExecFn = typeof runExec;

export type WindowsAclEntry = {
  principal: string;
  rights: string[];
  rawRights: string;
  canRead: boolean;
  canWrite: boolean;
};

export type WindowsAclSummary = {
  ok: boolean;
  entries: WindowsAclEntry[];
  untrustedWorld: WindowsAclEntry[];
  untrustedGroup: WindowsAclEntry[];
  trusted: WindowsAclEntry[];
  error?: string;
};

export type WindowsUserInfoProvider = () => { username?: string | null };

export type IcaclsResetCommandOptions = {
  isDir: boolean;
  env?: NodeJS.ProcessEnv;
  userInfo?: WindowsUserInfoProvider;
};

const INHERIT_FLAGS = new Set(["I", "OI", "CI", "IO", "NP"]);
const WORLD_PRINCIPALS = new Set([
  "everyone",
  "users",
  "builtin\\users",
  "authenticated users",
  "nt authority\\authenticated users",
]);
const TRUSTED_BASE = new Set([
  "nt authority\\system",
  "system",
  "builtin\\administrators",
  "creator owner",
  // Localized SYSTEM account names (French, German, Spanish, Portuguese)
  "autorite nt\\système",
  "nt-autorität\\system",
  "autoridad nt\\system",
  "autoridade nt\\system",
]);
const WORLD_SUFFIXES = ["\\users", "\\authenticated users"];
const TRUSTED_SUFFIXES = ["\\administrators", "\\system", "\\système"];

// Accept an optional leading * which icacls prefixes to SIDs when invoked with /sid
// (e.g. *S-1-5-18 instead of S-1-5-18).
const SID_RE = /^\*?s-\d+-\d+(-\d+)+$/i;
const TRUSTED_SIDS = new Set([
  "s-1-5-18",
  "s-1-5-32-544",
  "s-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
]);
// SIDs for world-equivalent principals that icacls /sid emits as raw SIDs.
// Without this list these would be classified as "group" instead of "world".
//   S-1-1-0        Everyone
//   S-1-5-11       Authenticated Users
//   S-1-5-32-545   BUILTIN\Users
const WORLD_SIDS = new Set(["s-1-1-0", "s-1-5-11", "s-1-5-32-545"]);
const STATUS_PREFIXES = [
  "successfully processed",
  "processed",
  "failed processing",
  "no mapping between account names",
];

const normalize = (value: string) => normalizeLowercaseStringOrEmpty(value);
const defaultWindowsUserInfo: WindowsUserInfoProvider = () => os.userInfo();

function normalizeSid(value: string): string {
  const normalized = normalize(value);
  return normalized.startsWith("*") ? normalized.slice(1) : normalized;
}

export function resolveWindowsUserPrincipal(
  env?: NodeJS.ProcessEnv,
  userInfo: WindowsUserInfoProvider = defaultWindowsUserInfo,
): string | null {
  const username = env?.USERNAME?.trim() || userInfo().username?.trim();
  if (!username) {
    return null;
  }
  const domain = env?.USERDOMAIN?.trim();
  return domain ? `${domain}\\${username}` : username;
}

function buildTrustedPrincipals(env?: NodeJS.ProcessEnv): Set<string> {
  const trusted = new Set<string>(TRUSTED_BASE);
  const principal = resolveWindowsUserPrincipal(env);
  if (principal) {
    trusted.add(normalize(principal));
    const parts = principal.split("\\");
    const userOnly = parts.at(-1);
    if (userOnly) {
      trusted.add(normalize(userOnly));
    }
  }
  const userSid = normalizeSid(env?.USERSID ?? "");
  // Guard: never add world-equivalent SIDs (Everyone, Authenticated Users, BUILTIN\\Users)
  // to the trusted set, even if USERSID is set to one of them by a malicious process.
  if (userSid && SID_RE.test(userSid) && !WORLD_SIDS.has(userSid)) {
    trusted.add(userSid);
  }
  return trusted;
}

function resolveWindowsSystemCommand(command: string, env?: NodeJS.ProcessEnv): string {
  const root =
    env?.SystemRoot?.trim() ||
    env?.SYSTEMROOT?.trim() ||
    env?.windir?.trim() ||
    env?.WINDIR?.trim();
  return root ? path.win32.join(root, "System32", command) : command;
}

function classifyPrincipal(
  principal: string,
  trustedPrincipals: Set<string>,
): "trusted" | "world" | "group" {
  const normalized = normalize(principal);

  if (SID_RE.test(normalized)) {
    // Strip the leading * that icacls /sid prefixes to SIDs before lookup.
    const sid = normalizeSid(normalized);
    // World-equivalent SIDs must be classified as "world", not "group", so
    // that callers applying world-write policies catch everyone/authenticated-
    // users entries the same way they would catch the human-readable names.
    if (WORLD_SIDS.has(sid)) {
      return "world";
    }
    if (TRUSTED_SIDS.has(sid) || trustedPrincipals.has(sid)) {
      return "trusted";
    }
    return "group";
  }

  if (
    trustedPrincipals.has(normalized) ||
    TRUSTED_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  ) {
    return "trusted";
  }
  if (
    WORLD_PRINCIPALS.has(normalized) ||
    WORLD_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  ) {
    return "world";
  }

  // Fallback: strip diacritics and re-check for localized SYSTEM variants
  const stripped = normalized.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (
    stripped !== normalized &&
    (TRUSTED_BASE.has(stripped) ||
      TRUSTED_SUFFIXES.some((suffix) => {
        const strippedSuffix = suffix.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        return stripped.endsWith(strippedSuffix);
      }))
  ) {
    return "trusted";
  }

  return "group";
}

function rightsFromTokens(tokens: string[]): {
  canRead: boolean;
  canWrite: boolean;
} {
  const upper = tokens.join("").toUpperCase();
  const canWrite =
    upper.includes("F") || upper.includes("M") || upper.includes("W") || upper.includes("D");
  const canRead = upper.includes("F") || upper.includes("M") || upper.includes("R");
  return { canRead, canWrite };
}

function isStatusLine(lowerLine: string): boolean {
  return STATUS_PREFIXES.some((prefix) => lowerLine.startsWith(prefix));
}

function stripTargetPrefix(params: {
  trimmedLine: string;
  lowerLine: string;
  normalizedTarget: string;
  lowerTarget: string;
  quotedTarget: string;
  quotedLower: string;
}): string {
  if (params.lowerLine.startsWith(params.lowerTarget)) {
    return params.trimmedLine.slice(params.normalizedTarget.length).trim();
  }
  if (params.lowerLine.startsWith(params.quotedLower)) {
    return params.trimmedLine.slice(params.quotedTarget.length).trim();
  }
  return params.trimmedLine;
}

function parseAceEntry(entry: string): WindowsAclEntry | null {
  if (!entry || !entry.includes("(")) {
    return null;
  }

  const idx = entry.indexOf(":");
  if (idx === -1) {
    return null;
  }

  const principal = entry.slice(0, idx).trim();
  const rawRights = entry.slice(idx + 1).trim();
  const tokens =
    rawRights
      .match(/\(([^)]+)\)/g)
      ?.map((token) => token.slice(1, -1).trim())
      .filter(Boolean) ?? [];

  if (tokens.some((token) => token.toUpperCase() === "DENY")) {
    return null;
  }

  const rights = tokens.filter((token) => !INHERIT_FLAGS.has(token.toUpperCase()));
  if (rights.length === 0) {
    return null;
  }

  const { canRead, canWrite } = rightsFromTokens(rights);
  return { principal, rights, rawRights, canRead, canWrite };
}

export function parseIcaclsOutput(output: string, targetPath: string): WindowsAclEntry[] {
  const entries: WindowsAclEntry[] = [];
  const normalizedTarget = targetPath.trim();
  const lowerTarget = normalizedTarget.toLowerCase();
  const quotedTarget = `"${normalizedTarget}"`;
  const quotedLower = quotedTarget.toLowerCase();

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      continue;
    }
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();
    if (isStatusLine(lower)) {
      continue;
    }

    const entry = stripTargetPrefix({
      trimmedLine: trimmed,
      lowerLine: lower,
      normalizedTarget,
      lowerTarget,
      quotedTarget,
      quotedLower,
    });
    const parsed = parseAceEntry(entry);
    if (!parsed) {
      continue;
    }
    entries.push(parsed);
  }

  return entries;
}

export function summarizeWindowsAcl(
  entries: WindowsAclEntry[],
  env?: NodeJS.ProcessEnv,
): Pick<WindowsAclSummary, "trusted" | "untrustedWorld" | "untrustedGroup"> {
  const trustedPrincipals = buildTrustedPrincipals(env);
  const trusted: WindowsAclEntry[] = [];
  const untrustedWorld: WindowsAclEntry[] = [];
  const untrustedGroup: WindowsAclEntry[] = [];
  for (const entry of entries) {
    const classification = classifyPrincipal(entry.principal, trustedPrincipals);
    if (classification === "trusted") {
      trusted.push(entry);
    } else if (classification === "world") {
      untrustedWorld.push(entry);
    } else {
      untrustedGroup.push(entry);
    }
  }
  return { trusted, untrustedWorld, untrustedGroup };
}

async function resolveCurrentUserSid(
  exec: ExecFn,
  env?: NodeJS.ProcessEnv,
): Promise<string | null> {
  try {
    const { stdout, stderr } = await exec(resolveWindowsSystemCommand("whoami.exe", env), [
      "/user",
      "/fo",
      "csv",
      "/nh",
    ]);
    const match = `${stdout}\n${stderr}`.match(/\*?S-\d+-\d+(?:-\d+)+/i);
    return match ? normalizeSid(match[0]) : null;
  } catch (err) {
    // Log but do not propagate — SID resolution is best-effort.
    // Callers fall back to env-based resolution when this returns null.
    log.warn("resolveCurrentUserSid failed", { error: String(err) });
    return null;
  }
}

export async function inspectWindowsAcl(
  targetPath: string,
  opts?: { env?: NodeJS.ProcessEnv; exec?: ExecFn },
): Promise<WindowsAclSummary> {
  const exec = opts?.exec ?? runExec;
  try {
    // /sid outputs security identifiers (e.g. *S-1-5-18) instead of locale-
    // dependent account names so the audit works correctly on non-English
    // Windows (Russian, Chinese, etc.) where icacls prints Cyrillic / CJK
    // characters that may be garbled when Node reads them in the wrong code
    // page.  Fixes #35834.
    const { stdout, stderr } = await exec(resolveWindowsSystemCommand("icacls.exe", opts?.env), [
      targetPath,
      "/sid",
    ]);
    const output = `${stdout}\n${stderr}`.trim();
    const entries = parseIcaclsOutput(output, targetPath);
    let effectiveEnv = opts?.env;
    let { trusted, untrustedWorld, untrustedGroup } = summarizeWindowsAcl(entries, effectiveEnv);

    const needsUserSidResolution =
      !effectiveEnv?.USERSID &&
      untrustedGroup.some((entry) => SID_RE.test(normalize(entry.principal)));
    if (needsUserSidResolution) {
      const currentUserSid = await resolveCurrentUserSid(exec, effectiveEnv);
      if (currentUserSid) {
        effectiveEnv = { ...effectiveEnv, USERSID: currentUserSid };
        ({ trusted, untrustedWorld, untrustedGroup } = summarizeWindowsAcl(entries, effectiveEnv));
      }
    }

    return { ok: true, entries, trusted, untrustedWorld, untrustedGroup };
  } catch (err) {
    return {
      ok: false,
      entries: [],
      trusted: [],
      untrustedWorld: [],
      untrustedGroup: [],
      error: String(err),
    };
  }
}

export function formatWindowsAclSummary(summary: WindowsAclSummary): string {
  if (!summary.ok) {
    return "unknown";
  }
  const untrusted = [...summary.untrustedWorld, ...summary.untrustedGroup];
  if (untrusted.length === 0) {
    return "trusted-only";
  }
  return untrusted.map((entry) => `${entry.principal}:${entry.rawRights}`).join(", ");
}

export function formatIcaclsResetCommand(
  targetPath: string,
  opts: IcaclsResetCommandOptions,
): string {
  const user = resolveWindowsUserPrincipal(opts.env, opts.userInfo) ?? "%USERNAME%";
  const grant = opts.isDir ? "(OI)(CI)F" : "F";
  return `icacls "${targetPath}" /inheritance:r /grant:r "${user}:${grant}" /grant:r "*S-1-5-18:${grant}"`;
}

export function createIcaclsResetCommand(
  targetPath: string,
  opts: IcaclsResetCommandOptions,
): { command: string; args: string[]; display: string } | null {
  const user = resolveWindowsUserPrincipal(opts.env, opts.userInfo);
  if (!user) {
    return null;
  }
  const grant = opts.isDir ? "(OI)(CI)F" : "F";
  const args = [
    targetPath,
    "/inheritance:r",
    "/grant:r",
    `${user}:${grant}`,
    "/grant:r",
    `*S-1-5-18:${grant}`,
  ];
  return {
    command: "icacls",
    args,
    display: formatIcaclsResetCommand(targetPath, opts),
  };
}
