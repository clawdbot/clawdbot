// Whatsapp plugin module implements targets runtime behavior.
import fs from "node:fs";
import path from "node:path";
import { normalizeE164 } from "openclaw/plugin-sdk/account-resolution";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import { chunkMarkdownTextWithMode, type ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  FormatCapabilityProfile,
  type MarkdownIR,
  markdownToIRWithMeta,
  renderMarkdownIRChunksWithinLimit,
  renderMarkdownWithMarkers,
  sliceMarkdownIR,
} from "openclaw/plugin-sdk/text-chunking";
import { CONFIG_DIR, resolveUserPath } from "openclaw/plugin-sdk/text-utility-runtime";

const WHATSAPP_FORMAT_CAPABILITIES = FormatCapabilityProfile.define({
  mechanism: "markdown",
  constructs: {
    underline: "strip",
    spoiler: "fallback",
    codeLanguage: "fallback",
    linkLabel: "fallback",
    heading: "fallback",
    taskList: "fallback",
    table: "fallback",
    image: "fallback",
  },
  chunk: { limit: 4_096, unit: "chars" },
});

const WHATSAPP_STYLE_MARKERS = {
  bold: { open: "*", close: "*" },
  italic: { open: "_", close: "_" },
  strikethrough: { open: "~", close: "~" },
  code: { open: "```", close: "```" },
  code_block: { open: "```\n", close: "```" },
} as const;

const WHATSAPP_INDENT_GUARD = "\u2060";
const WHATSAPP_MARKERS = ["*", "_", "~", "`"] as const;

type WhatsAppEscapedMarker = { source: string; placeholder: string };

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

function protectWhatsAppEscapedMarkers(text: string): {
  text: string;
  markers: WhatsAppEscapedMarker[];
} {
  const placeholders: string[] = [];
  for (const [start, end] of [
    [0xe000, 0xf8ff],
    [0xf0000, 0xffffd],
  ] as const) {
    for (
      let codePoint = start;
      codePoint <= end && placeholders.length < WHATSAPP_MARKERS.length;
      codePoint += 1
    ) {
      const candidate = String.fromCodePoint(codePoint);
      if (!text.includes(candidate)) {
        placeholders.push(candidate);
      }
    }
  }
  if (placeholders.length < WHATSAPP_MARKERS.length) {
    throw new Error("Unable to reserve WhatsApp formatting placeholders");
  }
  const markers = WHATSAPP_MARKERS.map((marker, index) => ({
    source: `\\${marker}`,
    placeholder: placeholders[index] ?? "",
  }));
  let protectedText = text;
  for (const { source, placeholder } of markers) {
    protectedText = protectedText.replaceAll(source, placeholder);
  }
  return { text: protectedText, markers };
}

function restoreWhatsAppEscapedMarkers(
  text: string,
  markers: readonly WhatsAppEscapedMarker[],
): string {
  let restored = text;
  for (const { source, placeholder } of markers) {
    restored = restored.replaceAll(placeholder, source);
  }
  return restored;
}

function renderWhatsAppMarkdownIR(
  ir: MarkdownIR,
  escapedMarkers: readonly WhatsAppEscapedMarker[],
): string {
  return renderMarkdownWithMarkers(
    ir,
    {
      styleMarkers: WHATSAPP_STYLE_MARKERS,
      escapeText: (value) => restoreWhatsAppEscapedMarkers(value, escapedMarkers),
    },
    WHATSAPP_FORMAT_CAPABILITIES,
  );
}

function prepareWhatsAppMarkdown(text: string, tableMode: MarkdownTableMode) {
  // Some outbound callers preserve leading indentation as presentation, while
  // CommonMark consumes it as block indentation. Guard only the parse.
  const guardedIndent = /^[\t ]/u.test(text);
  const escaped = protectWhatsAppEscapedMarkers(text);
  const markdown = guardedIndent ? `${WHATSAPP_INDENT_GUARD}${escaped.text}` : escaped.text;
  const trailingWhitespace = text.match(/\s+$/u)?.[0] ?? "";
  const { ir: parsedIr, hasTables } = markdownToIRWithMeta(markdown, {
    linkify: false,
    autolink: false,
    enableSpoilers: true,
    enableHtmlUnderline: true,
    enableTaskLists: true,
    headingStyle: "rich",
    blockquotePrefix: "> ",
    tableMode: tableMode === "block" ? "code" : tableMode,
    preserveSourceBlockSpacing: true,
  });
  let ir = parsedIr;
  if (guardedIndent && ir.text.startsWith(WHATSAPP_INDENT_GUARD)) {
    ir = sliceMarkdownIR(ir, WHATSAPP_INDENT_GUARD.length, ir.text.length);
  }
  if (!hasTables && trailingWhitespace) {
    ir.text = `${ir.text.trimEnd()}${trailingWhitespace}`;
  }
  return { ir, escapedMarkers: escaped.markers };
}

function splitWhatsAppIRForChunkMode(
  ir: MarkdownIR,
  limit: number,
  chunkMode: ChunkMode,
): MarkdownIR[] {
  if (chunkMode !== "newline") {
    return [ir];
  }
  const chunkTexts = chunkMarkdownTextWithMode(ir.text, limit, chunkMode);
  const chunks: MarkdownIR[] = [];
  let cursor = 0;
  for (const text of chunkTexts) {
    const start = ir.text.indexOf(text, cursor);
    if (start < 0) {
      return [ir];
    }
    const end = start + text.length;
    chunks.push(sliceMarkdownIR(ir, start, end));
    cursor = end;
  }
  return chunks;
}

export function markdownToWhatsAppChunks(
  text: string,
  limit: number,
  tableMode: MarkdownTableMode = "bullets",
  chunkMode: ChunkMode = "length",
): string[] {
  if (!text) {
    return [];
  }
  if (!text.trim()) {
    return chunkMarkdownTextWithMode(text, limit, chunkMode);
  }
  const { ir, escapedMarkers } = prepareWhatsAppMarkdown(text, tableMode);
  const render = (chunk: MarkdownIR) => renderWhatsAppMarkdownIR(chunk, escapedMarkers);
  const rendered = render(ir);
  let chunks =
    ir.styles.length === 0 && ir.links.length === 0
      ? chunkMarkdownTextWithMode(rendered, limit, chunkMode)
      : splitWhatsAppIRForChunkMode(ir, limit, chunkMode).flatMap((source) =>
          renderMarkdownIRChunksWithinLimit({
            ir: source,
            limit,
            renderChunk: render,
            measureRendered: (value) => value.length,
          }).map((chunk) => chunk.rendered),
        );
  if (chunkMode === "newline") {
    chunks = chunks.map((chunk) => chunk.trimEnd()).filter(Boolean);
  }
  return chunks;
}

export function markdownToWhatsApp(text: string, tableMode: MarkdownTableMode = "bullets"): string {
  return markdownToWhatsAppChunks(text, Number.POSITIVE_INFINITY, tableMode).join("");
}
