// Whatsapp plugin module implements targets runtime behavior.
import fs from "node:fs";
import path from "node:path";
import { normalizeE164 } from "openclaw/plugin-sdk/account-resolution";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { escapeRegExp } from "openclaw/plugin-sdk/text-utility-runtime";
import { CONFIG_DIR, resolveUserPath } from "openclaw/plugin-sdk/text-utility-runtime";

const WHATSAPP_FENCE_PLACEHOLDER = "\x00FENCE";
const WHATSAPP_INLINE_CODE_PLACEHOLDER = "\x00CODE";
// Terminates the numeric index in a placeholder so the restore regex cannot
// absorb a digit from adjacent user text (e.g. `code`5) into the index.
const WHATSAPP_PLACEHOLDER_TERMINATOR = "\x00";

export type WebChannel = "web";

export function assertWebChannel(input: string): asserts input is WebChannel {
  if (input !== "web") {
    throw new Error("Web channel must be 'web'");
  }
}

export function isSelfChatMode(
  selfE164: string | null | undefined,
  allowFrom?: Array<string | number> | null,
): boolean {
  if (!selfE164) {
    return false;
  }
  if (!Array.isArray(allowFrom) || allowFrom.length === 0) {
    return false;
  }
  const normalizedSelf = normalizeE164(selfE164);
  return allowFrom.some((n) => {
    if (n === "*") {
      return false;
    }
    try {
      return normalizeE164(String(n)) === normalizedSelf;
    } catch {
      return false;
    }
  });
}

export function toWhatsappJid(number: string): string {
  const withoutPrefix = number.replace(/^whatsapp:/i, "").trim();
  if (withoutPrefix.includes("@")) {
    return withoutPrefix;
  }
  const e164 = normalizeE164(withoutPrefix);
  const digits = e164.replace(/\D/g, "");
  return `${digits}@s.whatsapp.net`;
}

// LID-aware outbound JID resolver. When a forward mapping file
// `lid-mapping-{phone-digits}.json` is present in any candidate dir, prefer
// the `{lid}@lid` JID over `{phone-digits}@s.whatsapp.net`. This avoids the
// ghost-chat failure mode where messages route to a sender-only thread that
// never reaches recipients whose contact is internally LID-based (#67378).
export function toWhatsappJidWithLid(number: string, opts?: JidToE164Options): string {
  const stripped = number.replace(/^whatsapp:/i, "").trim();
  if (stripped.includes("@")) {
    return stripped;
  }
  const e164 = normalizeE164(stripped);
  const phoneDigits = e164.replace(/\D/g, "");
  const lid = readLidForwardMapping({ phoneDigits, opts });
  return lid ? `${lid}@lid` : `${phoneDigits}@s.whatsapp.net`;
}

export type JidToE164Options = {
  authDir?: string;
  lidMappingDirs?: string[];
  logMissing?: boolean;
};

type LidLookup = {
  getLIDForPN?: (jid: string) => Promise<string | null>;
  getPNForLID?: (jid: string) => Promise<string | null>;
};

function addUniqueString(target: string[], value: string | null | undefined): void {
  const normalized = value?.trim();
  if (normalized && !target.includes(normalized)) {
    target.push(normalized);
  }
}

async function tryLookupMappedJid(
  lookup: (() => Promise<string | null> | undefined) | undefined,
): Promise<string | null> {
  if (!lookup) {
    return null;
  }
  try {
    return (await lookup()) ?? null;
  } catch (err) {
    if (shouldLogVerbose()) {
      logVerbose(`LID mapping lookup failed: ${String(err)}`);
    }
    return null;
  }
}

const DIRECT_PN_JID_RE = /^(\d+)(?::\d+)?@(s\.whatsapp\.net|hosted)$/i;
const DIRECT_LID_JID_RE = /^(\d+)(?::\d+)?@(lid|hosted\.lid)$/i;

function addEquivalentDirectChatCandidate(target: string[], jid: string | null | undefined): void {
  addUniqueString(target, jid);
  const pnMatch = jid?.match(DIRECT_PN_JID_RE);
  if (pnMatch) {
    addUniqueString(target, `${pnMatch[1]}@${pnMatch[2]}`);
    return;
  }
  const lidMatch = jid?.match(DIRECT_LID_JID_RE);
  if (lidMatch) {
    addUniqueString(target, `${lidMatch[1]}@${lidMatch[2]}`);
  }
}

export async function resolveEquivalentWhatsAppDirectChatJids(
  jid: string | null | undefined,
  opts?: JidToE164Options & { lidLookup?: LidLookup },
): Promise<string[]> {
  const normalized = jid?.trim();
  if (!normalized) {
    return [];
  }

  const candidates: string[] = [];
  addEquivalentDirectChatCandidate(candidates, normalized);
  const pnMatch = normalized.match(DIRECT_PN_JID_RE);
  if (pnMatch) {
    const mappedLid = await tryLookupMappedJid(() => opts?.lidLookup?.getLIDForPN?.(normalized));
    addEquivalentDirectChatCandidate(candidates, mappedLid);

    const phoneDigits = pnMatch[1];
    const pnDomain = pnMatch[2];
    if (!phoneDigits || !pnDomain) {
      return candidates;
    }
    const mappedLocalLid = readLidForwardMapping({ phoneDigits, opts });
    const localLidDomain = pnDomain.toLowerCase() === "hosted" ? "hosted.lid" : "lid";
    addUniqueString(candidates, mappedLocalLid ? `${mappedLocalLid}@${localLidDomain}` : null);
    return candidates;
  }

  const lidMatch = normalized.match(DIRECT_LID_JID_RE);
  if (lidMatch) {
    const mappedPn = await tryLookupMappedJid(() => opts?.lidLookup?.getPNForLID?.(normalized));
    addEquivalentDirectChatCandidate(candidates, mappedPn);

    const lidDomain = lidMatch[2];
    if (!lidMatch[1] || !lidDomain) {
      return candidates;
    }
    const e164 = jidToE164(normalized, { ...opts, logMissing: false });
    const localPnJid =
      e164 && lidDomain.toLowerCase() === "hosted.lid"
        ? `${e164.replace(/\D/g, "")}@hosted`
        : e164
          ? toWhatsappJid(e164)
          : null;
    addUniqueString(candidates, localPnJid);
  }
  return candidates;
}

function resolveLidMappingDirs(params: { opts?: JidToE164Options }): string[] {
  const dirs = new Set<string>();
  const addDir = (dir?: string | null) => {
    if (!dir) {
      return;
    }
    dirs.add(resolveUserPath(dir));
  };
  addDir(params.opts?.authDir);
  for (const dir of params.opts?.lidMappingDirs ?? []) {
    addDir(dir);
  }
  addDir(CONFIG_DIR);
  addDir(path.join(CONFIG_DIR, "credentials"));
  return [...dirs];
}

function readLidReverseMapping(params: { lid: string; opts?: JidToE164Options }): string | null {
  const mappingFilename = `lid-mapping-${params.lid}_reverse.json`;
  const mappingDirs = resolveLidMappingDirs({ opts: params.opts });
  for (const dir of mappingDirs) {
    const mappingPath = path.join(dir, mappingFilename);
    try {
      const data = fs.readFileSync(mappingPath, "utf8");
      const phone = JSON.parse(data) as string | number | null;
      if (phone === null || phone === undefined) {
        continue;
      }
      return normalizeE164(String(phone));
    } catch {
      // next location
    }
  }
  return null;
}

function readLidForwardMapping(params: {
  phoneDigits: string;
  opts?: JidToE164Options;
}): string | null {
  const mappingFilename = `lid-mapping-${params.phoneDigits}.json`;
  const mappingDirs = resolveLidMappingDirs({ opts: params.opts });
  for (const dir of mappingDirs) {
    const mappingPath = path.join(dir, mappingFilename);
    try {
      const data = fs.readFileSync(mappingPath, "utf8");
      const lid = JSON.parse(data) as string | number | null;
      if (lid === null || lid === undefined) {
        continue;
      }
      const digits = String(lid).replace(/\D/g, "");
      if (digits) {
        return digits;
      }
    } catch {
      // next location
    }
  }
  return null;
}

export function jidToE164(jid: string, opts?: JidToE164Options): string | null {
  const match = jid.match(/^(\d+)(?::\d+)?@(s\.whatsapp\.net|hosted)$/);
  const phoneDigits = match?.[1];
  if (phoneDigits) {
    return `+${phoneDigits}`;
  }

  const lidMatch = jid.match(/^(\d+)(?::\d+)?@(lid|hosted\.lid)$/);
  if (!lidMatch) {
    return null;
  }
  const lid = lidMatch[1];
  if (!lid) {
    return null;
  }
  const phone = readLidReverseMapping({
    lid,
    opts,
  });
  if (phone) {
    return phone;
  }
  const shouldLog = opts?.logMissing ?? shouldLogVerbose();
  if (shouldLog) {
    logVerbose(`LID mapping not found for ${lidMatch[1]}; skipping inbound message`);
  }
  return null;
}

export async function resolveJidToE164(
  jid: string | null | undefined,
  opts?: JidToE164Options & { lidLookup?: LidLookup },
): Promise<string | null> {
  if (!jid) {
    return null;
  }
  const direct = jidToE164(jid, opts);
  if (direct) {
    return direct;
  }
  if (!/(@lid|@hosted\.lid)$/.test(jid) || !opts?.lidLookup?.getPNForLID) {
    return null;
  }
  try {
    const pnJid = await opts.lidLookup.getPNForLID(jid);
    if (!pnJid) {
      return null;
    }
    return jidToE164(pnJid, opts);
  } catch (err) {
    if (shouldLogVerbose()) {
      logVerbose(`LID mapping lookup failed for ${jid}: ${String(err)}`);
    }
    return null;
  }
}

export function markdownToWhatsApp(text: string): string {
  if (!text) {
    return text;
  }

  const fences: string[] = [];
  let result = text.replace(/```[\s\S]*?```/g, (match) => {
    fences.push(match);
    return `${WHATSAPP_FENCE_PLACEHOLDER}${fences.length - 1}${WHATSAPP_PLACEHOLDER_TERMINATOR}`;
  });

  const inlineCodes: string[] = [];
  result = result.replace(/`[^`\n]+`/g, (match) => {
    inlineCodes.push(match);
    return `${WHATSAPP_INLINE_CODE_PLACEHOLDER}${inlineCodes.length - 1}${WHATSAPP_PLACEHOLDER_TERMINATOR}`;
  });

  // Convert combined GFM strong+emphasis before plain strong so the plain
  // rules cannot leave literal `**` around the inner emphasis.
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, "*_$1_*");
  result = result.replace(/___(.+?)___/g, "*_$1_*");
  result = result.replace(/\*\*_(.+?)_\*\*/g, "*_$1_*");
  result = result.replace(/__\*(.+?)\*__/g, "*_$1_*");
  result = result.replace(/_\*\*(.+?)\*\*_/g, "*_$1_*");
  result = result.replace(/\*__(.+?)__\*/g, "*_$1_*");

  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");
  result = result.replace(/__(.+?)__/g, "*$1*");
  result = result.replace(/~~(.+?)~~/g, "~$1~");

  const terminator = escapeRegExp(WHATSAPP_PLACEHOLDER_TERMINATOR);
  result = result.replace(
    new RegExp(`${escapeRegExp(WHATSAPP_INLINE_CODE_PLACEHOLDER)}(\\d+)${terminator}`, "g"),
    (_, idx) => inlineCodes[Number(idx)] ?? "",
  );
  result = result.replace(
    new RegExp(`${escapeRegExp(WHATSAPP_FENCE_PLACEHOLDER)}(\\d+)${terminator}`, "g"),
    (_, idx) => fences[Number(idx)] ?? "",
  );
  return result;
}
