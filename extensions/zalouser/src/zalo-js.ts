import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
import { resolveStateDir as resolvePluginStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { normalizeZaloReactionIcon } from "./reaction.js";
import type {
  ZaloAuthStatus,
  ZaloEventMessage,
  ZaloGroupContext,
  ZaloGroup,
  ZaloGroupMember,
  ZaloInboundMessage,
  ZaloSendOptions,
  ZaloSendResult,
  ZcaFriend,
  ZcaUserInfo,
} from "./types.js";
import {
  TextStyle,
  type API,
  type Credentials,
  type GroupInfo,
  type LoginQRCallbackEvent,
  type Message,
  type User,
  createZalo,
} from "./zca-client.js";
import { LoginQRCallbackEventType, ThreadType } from "./zca-constants.js";

const API_LOGIN_TIMEOUT_MS = 20_000;
const QR_LOGIN_TTL_MS = 3 * 60_000;
const DEFAULT_QR_START_TIMEOUT_MS = 30_000;
const DEFAULT_QR_WAIT_TIMEOUT_MS = 120_000;
const GROUP_INFO_CHUNK_SIZE = 80;
const GROUP_CONTEXT_CACHE_TTL_MS = 5 * 60_000;
const GROUP_CONTEXT_CACHE_MAX_ENTRIES = 500;
const LISTENER_WATCHDOG_INTERVAL_MS = 30_000;
const LISTENER_WATCHDOG_MAX_GAP_MS = 35_000;

const apiByProfile = new Map<string, API>();
const apiInitByProfile = new Map<string, Promise<API>>();
const credentialSignaturesByProfile = new Map<string, string>();

type ActiveZaloQrLogin = {
  id: string;
  profile: string;
  startedAt: number;
  qrDataUrl?: string;
  connected: boolean;
  error?: string;
  abort?: () => void;
  waitPromise: Promise<void>;
};

const activeQrLogins = new Map<string, ActiveZaloQrLogin>();

type ActiveZaloListener = {
  profile: string;
  accountId: string;
  stop: () => void;
};

const activeListeners = new Map<string, ActiveZaloListener>();
const groupContextCache = new Map<string, { value: ZaloGroupContext; expiresAt: number }>();

type AccountInfoResponse = Awaited<ReturnType<API["fetchAccountInfo"]>>;

type ApiTypingCapability = {
  sendTypingEvent: (
    threadId: string,
    type?: (typeof ThreadType)[keyof typeof ThreadType],
  ) => Promise<unknown>;
};

type StoredZaloCredentials = {
  imei: string;
  cookie: Credentials["cookie"];
  userAgent: string;
  language?: string;
  createdAt: string;
  lastUsedAt?: string;
};

function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolvePluginStateDir(env, os.homedir);
}

function resolveCredentialsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "credentials", "zalouser");
}

function credentialsFilename(profile: string): string {
  const trimmed = normalizeLowercaseStringOrEmpty(profile);
  if (!trimmed || trimmed === "default") {
    return "credentials.json";
  }
  return `credentials-${encodeURIComponent(trimmed)}.json`;
}

function resolveCredentialsPath(profile: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveCredentialsDir(env), credentialsFilename(profile));
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function ensureCredentialsDir(): string {
  const dir = resolveCredentialsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Refusing to use non-directory Zalo credentials path");
  }
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best-effort on platforms that support POSIX permissions.
  }
  return dir;
}

function isReadableCredentialFile(filePath: string): boolean {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function assertWritableCredentialTarget(filePath: string): void {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Refusing to write Zalo credentials to symlinked path");
    }
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
}

function writeCredentialFileAtomic(filePath: string, payload: string): void {
  const dir = ensureCredentialsDir();
  assertWritableCredentialTarget(filePath);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    fs.writeFileSync(tempPath, payload, { encoding: "utf-8", mode: 0o600, flag: "wx" });
    try {
      fs.chmodSync(tempPath, 0o600);
    } catch {
      // Best-effort on platforms that support POSIX permissions.
    }
    fs.renameSync(tempPath, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Best-effort on platforms that support POSIX permissions.
    }
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // The temp file is normally moved by renameSync.
    }
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(label));
    }, timeoutMs);
    void promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeProfile(profile?: string | null): string {
  const trimmed = profile?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "default";
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function clampTextStyles(
  text: string,
  styles?: ZaloSendOptions["textStyles"],
): ZaloSendOptions["textStyles"] {
  if (!styles || styles.length === 0) {
    return undefined;
  }
  const maxLength = text.length;
  const clamped = styles
    .map((style) => {
      const start = Math.max(0, Math.min(style.start, maxLength));
      const end = Math.min(style.start + style.len, maxLength);
      if (end <= start) {
        return null;
      }
      if (style.st === TextStyle.Indent) {
        return {
          start,
          len: end - start,
          st: style.st,
          indentSize: style.indentSize,
        };
      }
      return {
        start,
        len: end - start,
        st: style.st,
      };
    })
    .filter((style): style is NonNullable<typeof style> => style !== null);
  return clamped.length > 0 ? clamped : undefined;
}

function toNumberId(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed.replace(/_\d+$/, "");
    }
  }
  return "";
}

function toStringValue(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return "";
}

function normalizeAccountInfoUser(info: AccountInfoResponse): User | null {
  if (!info || typeof info !== "object") {
    return null;
  }
  if ("profile" in info) {
    const profile = (info as { profile?: unknown }).profile;
    if (profile && typeof profile === "object") {
      return profile as User;
    }
    return null;
  }
  return info;
}

function toInteger(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  const parsed = Number.parseInt(
    typeof value === "string" ? value : typeof value === "number" ? String(value) : "",
    10,
  );
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function normalizeMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!content || typeof content !== "object") {
    return "";
  }
  const record = content as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  const href = typeof record.href === "string" ? record.href.trim() : "";
  const combined = [title, description, href].filter(Boolean).join("\n").trim();
  if (combined) {
    return combined;
  }
  try {
    return JSON.stringify(content);
  } catch {
    return "";
  }
}

function resolveInboundTimestamp(rawTs: unknown): number {
  if (typeof rawTs === "number" && Number.isFinite(rawTs)) {
    return rawTs > 1_000_000_000_000 ? rawTs : rawTs * 1000;
  }
  const parsed = Number.parseInt(
    typeof rawTs === "string" ? rawTs : typeof rawTs === "number" ? String(rawTs) : "",
    10,
  );
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Date.now();
  }
  return parsed > 1_000_000_000_000 ? parsed : parsed * 1000;
}

function extractMentionIds(rawMentions: unknown): string[] {
  if (!Array.isArray(rawMentions)) {
    return [];
  }
  const sink = new Set<string>();
  for (const entry of rawMentions) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as { uid?: unknown };
    const id = toNumberId(record.uid);
    if (id) {
      sink.add(id);
    }
  }
  return Array.from(sink);
}

type MentionSpan = {
  start: number;
  end: number;
};

function toNonNegativeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.trunc(value);
    return normalized >= 0 ? normalized : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return parsed >= 0 ? parsed : null;
    }
  }
  return null;
}

function extractOwnMentionSpans(
  rawMentions: unknown,
  ownUserId: string,
  contentLength: number,
): MentionSpan[] {
  if (!Array.isArray(rawMentions) || !ownUserId || contentLength <= 0) {
    return [];
  }
  const spans: MentionSpan[] = [];
  for (const entry of rawMentions) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as {
      uid?: unknown;
      pos?: unknown;
      start?: unknown;
      offset?: unknown;
      len?: unknown;
      length?: unknown;
    };
    const uid = toNumberId(record.uid);
    if (!uid || uid !== ownUserId) {
      continue;
    }
    const startRaw = toNonNegativeInteger(record.pos ?? record.start ?? record.offset);
    const lengthRaw = toNonNegativeInteger(record.len ?? record.length);
    if (startRaw === null || lengthRaw === null || lengthRaw <= 0) {
      continue;
    }
    const start = Math.min(startRaw, contentLength);
    const end = Math.min(start + lengthRaw, contentLength);
    if (end <= start) {
      continue;
    }
    spans.push({ start, end });
  }
  if (spans.length <= 1) {
    return spans;
  }
  spans.sort((a, b) => a.start - b.start);
  const merged: MentionSpan[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (!last || span.start > last.end) {
      merged.push({ ...span });
      continue;
    }
    last.end = Math.max(last.end, span.end);
  }
  return merged;
}

function stripOwnMentionsForCommandBody(
  content: string,
  rawMentions: unknown,
  ownUserId: string,
): string {
  if (!content || !ownUserId) {
    return content;
  }
  const spans = extractOwnMentionSpans(rawMentions, ownUserId, content.length);
  if (spans.length === 0) {
    return stripLeadingAtMentionForCommand(content);
  }
  let cursor = 0;
  let output = "";
  for (const span of spans) {
    if (span.start > cursor) {
      output += content.slice(cursor, span.start);
    }
    cursor = Math.max(cursor, span.end);
  }
  if (cursor < content.length) {
    output += content.slice(cursor);
  }
  return output.replace(/\s+/g, " ").trim();
}

function stripLeadingAtMentionForCommand(content: string): string {
  const fallbackMatch = content.match(/^\s*@[^\s]+(?:\s+|[:,-]\s*)([/!][\s\S]*)$/);
  if (!fallbackMatch) {
    return content;
  }
  return fallbackMatch[1].trim();
}

function resolveGroupNameFromMessageData(data: Record<string, unknown>): string | undefined {
  const candidates = [data.groupName, data.gName, data.idToName, data.threadName, data.roomName];
  for (const candidate of candidates) {
    const value = toStringValue(candidate);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function buildEventMessage(data: Record<string, unknown>): ZaloEventMessage | undefined {
  const msgId = toStringValue(data.msgId);
  const cliMsgId = toStringValue(data.cliMsgId);
  const uidFrom = toStringValue(data.uidFrom);
  const idTo = toStringValue(data.idTo);
  if (!msgId || !cliMsgId || !uidFrom || !idTo) {
    return undefined;
  }
  return {
    msgId,
    cliMsgId,
    uidFrom,
    idTo,
    msgType: toStringValue(data.msgType) || "webchat",
    st: toInteger(data.st, 0),
    at: toInteger(data.at, 0),
    cmd: toInteger(data.cmd, 0),
    ts: toStringValue(data.ts) || Date.now(),
  };
}

function extractSendMessageId(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const payload = result as {
    msgId?: string | number;
    message?: { msgId?: string | number } | null;
    attachment?: Array<{ msgId?: string | number }>;
  };
  const direct = payload.msgId;
  if (direct !== undefined && direct !== null) {
    return String(direct);
  }
  const primary = payload.message?.msgId;
  if (primary !== undefined && primary !== null) {
    return String(primary);
  }
  const attachmentId = payload.attachment?.[0]?.msgId;
  if (attachmentId !== undefined && attachmentId !== null) {
    return String(attachmentId);
  }
  return undefined;
}

function resolveMediaFileName(params: {
  mediaUrl: string;
  fileName?: string;
  contentType?: string;
  kind?: string;
}): string {
  const explicit = params.fileName?.trim();
  if (explicit) {
    return explicit;
  }

  try {
    const parsed = new URL(params.mediaUrl);
    const fromPath = path.basename(parsed.pathname).trim();
    if (fromPath) {
      return fromPath;
    }
  } catch {
    // ignore URL parse failures
  }

  const ext =
    params.contentType === "image/png"
      ? "png"
      : params.contentType === "image/webp"
        ? "webp"
        : params.contentType === "image/jpeg"
          ? "jpg"
          : params.contentType === "video/mp4"
            ? "mp4"
            : params.contentType === "audio/mpeg"
              ? "mp3"
              : params.contentType === "audio/ogg"
                ? "ogg"
                : params.contentType === "audio/wav"
                  ? "wav"
                  : params.kind === "video"
                    ? "mp4"
                    : params.kind === "audio"
                      ? "mp3"
                      : params.kind === "image"
                        ? "jpg"
                        : "bin";

  return `upload.${ext}`;
}

function resolveUploadedVoiceAsset(
  uploaded: Array<{
    fileType?: string;
    fileUrl?: string;
    fileName?: string;
  }>,
): { fileUrl: string; fileName?: string } | undefined {
  for (const item of uploaded) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const fileType = normalizeOptionalLowercaseString(item.fileType);
    const fileUrl = item.fileUrl?.trim();
    if (!fileUrl) {
      continue;
    }
    if (fileType === "others" || fileType === "video") {
      return { fileUrl, fileName: normalizeOptionalString(item.fileName) };
    }
  }
  return undefined;
}

function buildZaloVoicePlaybackUrl(asset: { fileUrl: string; fileName?: string }): string {
  // zca-js uses uploadAttachment(...).fileUrl directly for sendVoice.
  // Appending filename can produce URLs that play only in the local session.
  return asset.fileUrl.trim();
}

function mapFriend(friend: User): ZcaFriend {
  return {
    userId: friend.userId,
    displayName: friend.displayName || friend.zaloName || friend.username || friend.userId,
    avatar: friend.avatar || undefined,
  };
}

function mapGroup(groupId: string, group: GroupInfo & Record<string, unknown>): ZaloGroup {
  const totalMember =
    typeof group.totalMember === "number" && Number.isFinite(group.totalMember)
      ? group.totalMember
      : undefined;
  return {
    groupId,
    name: group.name?.trim() || groupId,
    memberCount: totalMember,
  };
}

function readCredentials(profile: string): StoredZaloCredentials | null {
  const filePath = resolveCredentialsPath(profile);
  try {
    if (!isReadableCredentialFile(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<StoredZaloCredentials>;
    if (
      typeof parsed.imei !== "string" ||
      !parsed.imei ||
      !parsed.cookie ||
      typeof parsed.userAgent !== "string" ||
      !parsed.userAgent
    ) {
      return null;
    }
    const credentials = {
      imei: parsed.imei,
      cookie: parsed.cookie as Credentials["cookie"],
      userAgent: parsed.userAgent,
      language: typeof parsed.language === "string" ? parsed.language : undefined,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
      lastUsedAt: typeof parsed.lastUsedAt === "string" ? parsed.lastUsedAt : undefined,
    };
    credentialSignaturesByProfile.set(profile, credentialSignature(credentials));
    return credentials;
  } catch {
    return null;
  }
}

function credentialSignature(
  credentials: Omit<StoredZaloCredentials, "createdAt" | "lastUsedAt">,
): string {
  return JSON.stringify({
    imei: credentials.imei,
    cookie: canonicalCredentialCookie(credentials.cookie),
    userAgent: credentials.userAgent,
    language: credentials.language,
  });
}

function stableCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableCanonicalValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableCanonicalValue(entry)]),
  );
}

function stableSignatureValue(value: unknown): string {
  return JSON.stringify(stableCanonicalValue(value)) ?? "undefined";
}

function canonicalCookieArray(value: unknown[]): unknown[] {
  return value
    .map(stableCanonicalValue)
    .toSorted((left, right) =>
      stableSignatureValue(left).localeCompare(stableSignatureValue(right)),
    );
}

function canonicalCredentialCookie(cookie: Credentials["cookie"]): unknown {
  if (Array.isArray(cookie)) {
    return canonicalCookieArray(cookie);
  }
  if (!cookie || typeof cookie !== "object") {
    return cookie;
  }
  return Object.fromEntries(
    Object.entries(cookie as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [
        key,
        key === "cookies" && Array.isArray(entry)
          ? canonicalCookieArray(entry)
          : stableCanonicalValue(entry),
      ]),
  );
}

function writeCredentials(
  profile: string,
  credentials: Omit<StoredZaloCredentials, "createdAt" | "lastUsedAt">,
): void {
  const existing = readCredentials(profile);
  const now = new Date().toISOString();
  const next: StoredZaloCredentials = {
    ...credentials,
    createdAt: existing?.createdAt ?? now,
    lastUsedAt: now,
  };
  writeCredentialFileAtomic(resolveCredentialsPath(profile), JSON.stringify(next, null, 2));
  credentialSignaturesByProfile.set(profile, credentialSignature(next));
}

function snapshotApiCredentials(
  api: API,
  fallback?: Partial<Omit<StoredZaloCredentials, "createdAt" | "lastUsedAt">>,
): Omit<StoredZaloCredentials, "createdAt" | "lastUsedAt"> {
  const ctx = api.getContext();
  const cookieJson = api.getCookie().toJSON();
  const refreshedCookies =
    Array.isArray(cookieJson?.cookies) && cookieJson.cookies.length > 0
      ? cookieJson.cookies
      : fallback?.cookie;
  const imei = normalizeOptionalString(ctx.imei) ?? normalizeOptionalString(fallback?.imei);
  const userAgent =
    normalizeOptionalString(ctx.userAgent) ?? normalizeOptionalString(fallback?.userAgent);
  if (!imei || !refreshedCookies || !userAgent) {
    throw new Error("Zalo API session did not expose refreshed credentials");
  }
  return {
    imei,
    cookie: refreshedCookies as Credentials["cookie"],
    userAgent,
    language: normalizeOptionalString(ctx.language) ?? normalizeOptionalString(fallback?.language),
  };
}

function writeApiCredentials(
  profile: string,
  api: API,
  fallback?: Partial<Omit<StoredZaloCredentials, "createdAt" | "lastUsedAt">>,
): void {
  writeCredentials(profile, snapshotApiCredentials(api, fallback));
}

function writeApiCredentialsIfChanged(profile: string, api: API): boolean {
  const credentials = snapshotApiCredentials(api);
  const signature = credentialSignature(credentials);
  if (credentialSignaturesByProfile.get(profile) === signature) {
    return false;
  }
  writeCredentials(profile, credentials);
  return true;
}

function persistApiCredentialsIfChanged(profile: string, api: API): void {
  try {
    writeApiCredentialsIfChanged(profile, api);
  } catch {
    // Do not fail an already-successful Zalo operation only because the
    // best-effort session refresh could not be persisted.
  }
}

function clearCredentials(profile: string): boolean {
  const filePath = resolveCredentialsPath(profile);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      credentialSignaturesByProfile.delete(profile);
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

async function ensureApi(
  profileInput?: string | null,
  timeoutMs = API_LOGIN_TIMEOUT_MS,
): Promise<API> {
  const profile = normalizeProfile(profileInput);
  const cached = apiByProfile.get(profile);
  if (cached) {
    return cached;
  }

  const pending = apiInitByProfile.get(profile);
  if (pending) {
    return await pending;
  }

  const initPromise = (async () => {
    const stored = readCredentials(profile);
    if (!stored) {
      throw new Error(`No saved Zalo session for profile "${profile}"`);
    }
    const zalo = await createZalo({
      logging: false,
      selfListen: false,
    });
    const api = await withTimeout(
      zalo.login({
        imei: stored.imei,
        cookie: stored.cookie,
        userAgent: stored.userAgent,
        language: stored.language,
      }),
      timeoutMs,
      `Timed out restoring Zalo session for profile "${profile}"`,
    );
    apiByProfile.set(profile, api);
    writeApiCredentials(profile, api, stored);
    return api;
  })();

  apiInitByProfile.set(profile, initPromise);
  try {
    return await initPromise;
  } catch (error) {
    apiByProfile.delete(profile);
    throw error;
  } finally {
    apiInitByProfile.delete(profile);
  }
}

async function withZaloApi<T>(
  profileInput: string | null | undefined,
  operation: (api: API) => Promise<T>,
  options: {
    timeoutMs?: number;
    shouldPersist?: (result: T) => boolean;
  } = {},
): Promise<T> {
  const profile = normalizeProfile(profileInput);
  const api = await ensureApi(profile, options.timeoutMs);
  const result = await operation(api);
  if (options.shouldPersist?.(result) ?? true) {
    persistApiCredentialsIfChanged(profile, api);
  }
  return result;
}

function invalidateApi(profileInput?: string | null): void {
  const profile = normalizeProfile(profileInput);
  const api = apiByProfile.get(profile);
  if (api) {
    try {
      api.listener.stop();
    } catch {
      // ignore
    }
  }
  apiByProfile.delete(profile);
  apiInitByProfile.delete(profile);
}

function isQrLoginFresh(login: ActiveZaloQrLogin): boolean {
  return Date.now() - login.startedAt < QR_LOGIN_TTL_MS;
}

function resetQrLogin(profileInput?: string | null): void {
  const profile = normalizeProfile(profileInput);
  const active = activeQrLogins.get(profile);
  if (!active) {
    return;
  }
  try {
    active.abort?.();
  } catch {
    // ignore
  }
  activeQrLogins.delete(profile);
}

async function fetchGroupsByIds(api: API, ids: string[]): Promise<Map<string, GroupInfo>> {
  const result = new Map<string, GroupInfo>();
  for (let index = 0; index < ids.length; index += GROUP_INFO_CHUNK_SIZE) {
    const chunk = ids.slice(index, index + GROUP_INFO_CHUNK_SIZE);
    if (chunk.length === 0) {
      continue;
    }
    const response = await api.getGroupInfo(chunk);
    const map = response.gridInfoMap ?? {};
    for (const [groupId, info] of Object.entries(map)) {
      result.set(groupId, info);
    }
  }
  return result;
}

function makeGroupContextCacheKey(profile: string, groupId: string): string {
  return `${profile}:${groupId}`;
}

function readCachedGroupContext(profile: string, groupId: string): ZaloGroupContext | null {
  const key = makeGroupContextCacheKey(profile, groupId);
  const cached = groupContextCache.get(key);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= Date.now()) {
    groupContextCache.delete(key);
    return null;
  }
  // Bump recency so hot groups stay in cache when enforcing max entries.
  groupContextCache.delete(key);
  groupContextCache.set(key, cached);
  return cached.value;
}

function trimGroupContextCache(now: number): void {
  for (const [key, value] of groupContextCache) {
    if (value.expiresAt > now) {
      continue;
    }
    groupContextCache.delete(key);
  }
  while (groupContextCache.size > GROUP_CONTEXT_CACHE_MAX_ENTRIES) {
    const oldestKey = groupContextCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    groupContextCache.delete(oldestKey);
  }
}

function writeCachedGroupContext(profile: string, context: ZaloGroupContext): void {
  const now = Date.now();
  const key = makeGroupContextCacheKey(profile, context.groupId);
  if (groupContextCache.has(key)) {
    groupContextCache.delete(key);
  }
  groupContextCache.set(key, {
    value: context,
    expiresAt: now + GROUP_CONTEXT_CACHE_TTL_MS,
  });
  trimGroupContextCache(now);
}

function clearCachedGroupContext(profile: string): void {
  for (const key of groupContextCache.keys()) {
    if (key.startsWith(`${profile}:`)) {
      groupContextCache.delete(key);
    }
  }
}

function extractGroupMembersFromInfo(
  groupInfo: (GroupInfo & { currentMems?: unknown[]; memVerList?: unknown[] }) | undefined,
): string[] | undefined {
  if (!groupInfo || !Array.isArray(groupInfo.currentMems)) {
    return undefined;
  }
  const members = groupInfo.currentMems
    .map((member) => {
      if (!member || typeof member !== "object") {
        return "";
      }
      const record = member as { dName?: unknown; zaloName?: unknown };
      return toStringValue(record.dName) || toStringValue(record.zaloName);
    })
    .filter(Boolean);
  if (members.length === 0) {
    return undefined;
  }
  return members;
}

function toInboundMessage(message: Message, ownUserId?: string): ZaloInboundMessage | null {
  const data = message.data;
  const isGroup = message.type === ThreadType.Group;
  const senderId = toNumberId(data.uidFrom);
  const threadId = isGroup
    ? toNumberId(data.idTo)
    : toNumberId(data.uidFrom) || toNumberId(data.idTo);
  if (!threadId || !senderId) {
    return null;
  }
  const content = normalizeMessageContent(data.content);
  const normalizedOwnUserId = toNumberId(ownUserId);
  const mentionIds = extractMentionIds(data.mentions);
  const quoteOwnerId =
    data.quote && typeof data.quote === "object"
      ? toNumberId((data.quote as { ownerId?: unknown }).ownerId)
      : "";
  const hasAnyMention = mentionIds.length > 0;
  const canResolveExplicitMention = Boolean(normalizedOwnUserId);
  const wasExplicitlyMentioned = Boolean(
    normalizedOwnUserId && mentionIds.some((id) => id === normalizedOwnUserId),
  );
  const commandContent = wasExplicitlyMentioned
    ? stripOwnMentionsForCommandBody(content, data.mentions, normalizedOwnUserId)
    : hasAnyMention && !canResolveExplicitMention
      ? stripLeadingAtMentionForCommand(content)
      : content;
  const implicitMention = Boolean(
    normalizedOwnUserId && quoteOwnerId && quoteOwnerId === normalizedOwnUserId,
  );
  const eventMessage = buildEventMessage(data);
  return {
    threadId,
    isGroup,
    senderId,
    senderName: typeof data.dName === "string" ? data.dName.trim() || undefined : undefined,
    groupName: isGroup ? resolveGroupNameFromMessageData(data) : undefined,
    content,
    commandContent,
    timestampMs: resolveInboundTimestamp(data.ts),
    msgId: typeof data.msgId === "string" ? data.msgId : undefined,
    cliMsgId: typeof data.cliMsgId === "string" ? data.cliMsgId : undefined,
    hasAnyMention,
    canResolveExplicitMention,
    wasExplicitlyMentioned,
    implicitMention,
    eventMessage,
    raw: message,
  };
}

export function zalouserSessionExists(profileInput?: string | null): boolean {
  const profile = normalizeProfile(profileInput);
  return readCredentials(profile) !== null;
}

export async function checkZaloAuthenticated(profileInput?: string | null): Promise<boolean> {
  const profile = normalizeProfile(profileInput);
  if (!zalouserSessionExists(profile)) {
    return false;
  }
  try {
    await withZaloApi(
      profile,
      async (api) =>
        await withTimeout(api.fetchAccountInfo(), 12_000, "Timed out checking Zalo session"),
      { timeoutMs: 12_000 },
    );
    return true;
  } catch {
    invalidateApi(profile);
    return false;
  }
}

export async function getZaloUserInfo(profileInput?: string | null): Promise<ZcaUserInfo | null> {
  const profile = normalizeProfile(profileInput);
  return await withZaloApi(profile, async (api) => {
    const info = await api.fetchAccountInfo();
    const user = normalizeAccountInfoUser(info);
    if (!user?.userId) {
      return null;
    }
    return {
      userId: user.userId,
      displayName: user.displayName || user.zaloName || user.userId,
      avatar: user.avatar || undefined,
    };
  });
}

export async function listZaloFriends(profileInput?: string | null): Promise<ZcaFriend[]> {
  const profile = normalizeProfile(profileInput);
  return await withZaloApi(profile, async (api) => {
    const friends = await api.getAllFriends();
    return friends.map(mapFriend);
  });
}

export async function listZaloFriendsMatching(
  profileInput: string | null | undefined,
  query?: string | null,
): Promise<ZcaFriend[]> {
  const friends = await listZaloFriends(profileInput);
  const q = normalizeOptionalLowercaseString(query);
  if (!q) {
    return friends;
  }
  const scored = friends
    .map((friend) => {
      const id = normalizeLowercaseStringOrEmpty(friend.userId);
      const name = normalizeLowercaseStringOrEmpty(friend.displayName);
      const exact = id === q || name === q;
      const includes = id.includes(q) || name.includes(q);
      return { friend, exact, includes };
    })
    .filter((entry) => entry.includes)
    .toSorted((a, b) => Number(b.exact) - Number(a.exact));
  return scored.map((entry) => entry.friend);
}

export async function listZaloGroups(profileInput?: string | null): Promise<ZaloGroup[]> {
  const profile = normalizeProfile(profileInput);
  return await withZaloApi(profile, async (api) => {
    const allGroups = await api.getAllGroups();
    const ids = Object.keys(allGroups.gridVerMap ?? {});
    if (ids.length === 0) {
      return [];
    }
    const details = await fetchGroupsByIds(api, ids);
    const rows: ZaloGroup[] = [];
    for (const id of ids) {
      const info = details.get(id);
      if (!info) {
        rows.push({ groupId: id, name: id });
        continue;
      }
      rows.push(mapGroup(id, info as GroupInfo & Record<string, unknown>));
    }
    return rows;
  });
}

export async function listZaloGroupsMatching(
  profileInput: string | null | undefined,
  query?: string | null,
): Promise<ZaloGroup[]> {
  const groups = await listZaloGroups(profileInput);
  const q = normalizeOptionalLowercaseString(query);
  if (!q) {
    return groups;
  }
  return groups.filter((group) => {
    const id = normalizeLowercaseStringOrEmpty(group.groupId);
    const name = normalizeLowercaseStringOrEmpty(group.name);
    return id.includes(q) || name.includes(q);
  });
}

export async function listZaloGroupMembers(
  profileInput: string | null | undefined,
  groupId: string,
): Promise<ZaloGroupMember[]> {
  const profile = normalizeProfile(profileInput);
  return await withZaloApi(profile, async (api) => {
    const infoResponse = await api.getGroupInfo(groupId);
    const groupInfo = infoResponse.gridInfoMap?.[groupId] as
      | (GroupInfo & { memVerList?: unknown })
      | undefined;
    if (!groupInfo) {
      return [];
    }

    const memberIds = Array.isArray(groupInfo.memberIds)
      ? groupInfo.memberIds.map((id: unknown) => toNumberId(id)).filter(Boolean)
      : [];
    const memVerIds = Array.isArray(groupInfo.memVerList)
      ? groupInfo.memVerList.map((id: unknown) => toNumberId(id)).filter(Boolean)
      : [];
    const currentMembers = Array.isArray(groupInfo.currentMems) ? groupInfo.currentMems : [];

    const currentById = new Map<string, { displayName?: string; avatar?: string }>();
    for (const member of currentMembers) {
      const id = toNumberId(member?.id);
      if (!id) {
        continue;
      }
      currentById.set(id, {
        displayName:
          normalizeOptionalString(member.dName) ?? normalizeOptionalString(member.zaloName),
        avatar: member.avatar || undefined,
      });
    }

    const uniqueIds = Array.from(
      new Set<string>([...memberIds, ...memVerIds, ...currentById.keys()]),
    );

    const profileMap = new Map<string, { displayName?: string; avatar?: string }>();
    if (uniqueIds.length > 0) {
      const profiles = await api.getGroupMembersInfo(uniqueIds);
      const profileEntries = profiles.profiles as Record<
        string,
        {
          id?: string;
          displayName?: string;
          zaloName?: string;
          avatar?: string;
        }
      >;
      for (const [rawId, profileValue] of Object.entries(profileEntries)) {
        const id = toNumberId(rawId) || toNumberId((profileValue as { id?: unknown })?.id);
        if (!id || !profileValue) {
          continue;
        }
        profileMap.set(id, {
          displayName:
            normalizeOptionalString(profileValue.displayName) ??
            normalizeOptionalString(profileValue.zaloName),
          avatar: profileValue.avatar || undefined,
        });
      }
    }

    return uniqueIds.map((id) => ({
      userId: id,
      displayName: profileMap.get(id)?.displayName || currentById.get(id)?.displayName || id,
      avatar: profileMap.get(id)?.avatar || currentById.get(id)?.avatar,
    }));
  });
}

export async function resolveZaloGroupContext(
  profileInput: string | null | undefined,
  groupId: string,
): Promise<ZaloGroupContext> {
  const profile = normalizeProfile(profileInput);
  const normalizedGroupId = toNumberId(groupId) || groupId.trim();
  if (!normalizedGroupId) {
    throw new Error("groupId is required");
  }
  const cached = readCachedGroupContext(profile, normalizedGroupId);
  if (cached) {
    return cached;
  }

  return await withZaloApi(profile, async (api) => {
    const response = await api.getGroupInfo(normalizedGroupId);
    const groupInfo = response.gridInfoMap?.[normalizedGroupId] as
      | (GroupInfo & { currentMems?: unknown[]; memVerList?: unknown[] })
      | undefined;
    const context: ZaloGroupContext = {
      groupId: normalizedGroupId,
      name: normalizeOptionalString(groupInfo?.name),
      members: extractGroupMembersFromInfo(groupInfo),
    };
    writeCachedGroupContext(profile, context);
    return context;
  });
}

export async function sendZaloTextMessage(
  threadId: string,
  text: string,
  options: ZaloSendOptions = {},
): Promise<ZaloSendResult> {
  const profile = normalizeProfile(options.profile);
  const trimmedThreadId = threadId.trim();
  if (!trimmedThreadId) {
    return { ok: false, error: "No threadId provided" };
  }

  return await withZaloApi(
    profile,
    async (api) => {
      const type = options.isGroup ? ThreadType.Group : ThreadType.User;

      try {
        if (options.mediaUrl?.trim()) {
          const media = await loadOutboundMediaFromUrl(options.mediaUrl.trim(), {
            mediaLocalRoots: options.mediaLocalRoots,
            mediaReadFile: options.mediaReadFile,
          });
          const fileName = resolveMediaFileName({
            mediaUrl: options.mediaUrl,
            fileName: media.fileName,
            contentType: media.contentType,
            kind: media.kind,
          });
          const payloadText = (text || options.caption || "").slice(0, 2000);
          const textStyles = clampTextStyles(payloadText, options.textStyles);

          if (media.kind === "audio") {
            let textMessageId: string | undefined;
            if (payloadText) {
              const textResponse = await api.sendMessage(
                textStyles ? { msg: payloadText, styles: textStyles } : payloadText,
                trimmedThreadId,
                type,
              );
              textMessageId = extractSendMessageId(textResponse);
            }

            const attachmentFileName = fileName.includes(".") ? fileName : `${fileName}.bin`;
            const uploaded = await api.uploadAttachment(
              [
                {
                  data: media.buffer,
                  filename: attachmentFileName as `${string}.${string}`,
                  metadata: {
                    totalSize: media.buffer.length,
                  },
                },
              ],
              trimmedThreadId,
              type,
            );
            const voiceAsset = resolveUploadedVoiceAsset(uploaded);
            if (!voiceAsset) {
              throw new Error("Failed to resolve uploaded audio URL for voice message");
            }
            const voiceUrl = buildZaloVoicePlaybackUrl(voiceAsset);
            const response = await api.sendVoice({ voiceUrl }, trimmedThreadId, type);
            return {
              ok: true,
              messageId: extractSendMessageId(response) ?? textMessageId,
            };
          }

          const response = await api.sendMessage(
            {
              msg: payloadText,
              ...(textStyles ? { styles: textStyles } : {}),
              attachments: [
                {
                  data: media.buffer,
                  filename: fileName.includes(".") ? fileName : `${fileName}.bin`,
                  metadata: {
                    totalSize: media.buffer.length,
                  },
                },
              ],
            },
            trimmedThreadId,
            type,
          );
          return { ok: true, messageId: extractSendMessageId(response) };
        }

        const payloadText = text.slice(0, 2000);
        const textStyles = clampTextStyles(payloadText, options.textStyles);
        const response = await api.sendMessage(
          textStyles ? { msg: payloadText, styles: textStyles } : payloadText,
          trimmedThreadId,
          type,
        );
        return { ok: true, messageId: extractSendMessageId(response) };
      } catch (error) {
        return { ok: false, error: toErrorMessage(error) };
      }
    },
    { shouldPersist: (result) => result.ok },
  );
}

export async function sendZaloTypingEvent(
  threadId: string,
  options: Pick<ZaloSendOptions, "profile" | "isGroup"> = {},
): Promise<void> {
  const profile = normalizeProfile(options.profile);
  const trimmedThreadId = threadId.trim();
  if (!trimmedThreadId) {
    throw new Error("No threadId provided");
  }
  await withZaloApi(profile, async (api) => {
    const type = options.isGroup ? ThreadType.Group : ThreadType.User;
    if ("sendTypingEvent" in api && typeof api.sendTypingEvent === "function") {
      await (api as API & ApiTypingCapability).sendTypingEvent(trimmedThreadId, type);
      return;
    }
    throw new Error("Zalo typing indicator is not supported by current API session");
  });
}

async function resolveOwnUserId(api: API): Promise<string> {
  try {
    const info = await api.fetchAccountInfo();
    const resolved = toNumberId(normalizeAccountInfoUser(info)?.userId);
    if (resolved) {
      return resolved;
    }
  } catch {
    // Fall back to getOwnId when account info shape changes.
  }

  try {
    const ownId = toNumberId(api.getOwnId());
    if (ownId) {
      return ownId;
    }
  } catch {
    // Ignore fallback probe failures and keep mention detection conservative.
  }

  return "";
}

export async function sendZaloReaction(params: {
  profile?: string | null;
  threadId: string;
  isGroup?: boolean;
  msgId: string;
  cliMsgId: string;
  emoji: string;
  remove?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  const profile = normalizeProfile(params.profile);
  const threadId = params.threadId.trim();
  const msgId = toStringValue(params.msgId);
  const cliMsgId = toStringValue(params.cliMsgId);
  if (!threadId || !msgId || !cliMsgId) {
    return { ok: false, error: "threadId, msgId, and cliMsgId are required" };
  }
  try {
    return await withZaloApi(
      profile,
      async (api) => {
        const type = params.isGroup ? ThreadType.Group : ThreadType.User;
        const icon = params.remove
          ? { rType: -1, source: 6, icon: "" }
          : normalizeZaloReactionIcon(params.emoji);
        await api.addReaction(icon, {
          data: { msgId, cliMsgId },
          threadId,
          type,
        });
        return { ok: true };
      },
      { shouldPersist: (result) => result.ok },
    );
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

export async function sendZaloDeliveredEvent(params: {
  profile?: string | null;
  isGroup?: boolean;
  message: ZaloEventMessage;
  isSeen?: boolean;
}): Promise<void> {
  const profile = normalizeProfile(params.profile);
  await withZaloApi(profile, async (api) => {
    const type = params.isGroup ? ThreadType.Group : ThreadType.User;
    await api.sendDeliveredEvent(params.isSeen === true, params.message, type);
  });
}

export async function sendZaloSeenEvent(params: {
  profile?: string | null;
  isGroup?: boolean;
  message: ZaloEventMessage;
}): Promise<void> {
  const profile = normalizeProfile(params.profile);
  await withZaloApi(profile, async (api) => {
    const type = params.isGroup ? ThreadType.Group : ThreadType.User;
    await api.sendSeenEvent(params.message, type);
  });
}

export async function sendZaloLink(
  threadId: string,
  url: string,
  options: ZaloSendOptions = {},
): Promise<ZaloSendResult> {
  const profile = normalizeProfile(options.profile);
  const trimmedThreadId = threadId.trim();
  const trimmedUrl = url.trim();
  if (!trimmedThreadId) {
    return { ok: false, error: "No threadId provided" };
  }
  if (!trimmedUrl) {
    return { ok: false, error: "No URL provided" };
  }

  try {
    return await withZaloApi(
      profile,
      async (api) => {
        const type = options.isGroup ? ThreadType.Group : ThreadType.User;
        const response = await api.sendLink(
          { link: trimmedUrl, msg: options.caption },
          trimmedThreadId,
          type,
        );
        return { ok: true, messageId: String(response.msgId) };
      },
      { shouldPersist: (result) => result.ok },
    );
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

export async function startZaloQrLogin(params: {
  profile?: string | null;
  force?: boolean;
  timeoutMs?: number;
}): Promise<{ qrDataUrl?: string; message: string }> {
  const profile = normalizeProfile(params.profile);

  if (!params.force && (await checkZaloAuthenticated(profile))) {
    const info = await getZaloUserInfo(profile).catch(() => null);
    const name = info?.displayName ? ` (${info.displayName})` : "";
    return {
      message: `Zalo is already linked${name}.`,
    };
  }

  if (params.force) {
    await logoutZaloProfile(profile);
  }

  const existing = activeQrLogins.get(profile);
  if (existing && isQrLoginFresh(existing)) {
    if (existing.qrDataUrl) {
      return {
        qrDataUrl: existing.qrDataUrl,
        message: "QR already active. Scan it with the Zalo app.",
      };
    }
  } else if (existing) {
    resetQrLogin(profile);
  }

  if (!activeQrLogins.has(profile)) {
    const login: ActiveZaloQrLogin = {
      id: randomUUID(),
      profile,
      startedAt: Date.now(),
      connected: false,
      waitPromise: Promise.resolve(),
    };

    login.waitPromise = (async () => {
      let capturedCredentials: Omit<StoredZaloCredentials, "createdAt" | "lastUsedAt"> | null =
        null;
      try {
        const zalo = await createZalo({ logging: false, selfListen: false });
        const api = await zalo.loginQR(undefined, (event: LoginQRCallbackEvent) => {
          const current = activeQrLogins.get(profile);
          if (!current || current.id !== login.id) {
            return;
          }

          if (event.actions?.abort) {
            current.abort = () => {
              try {
                event.actions?.abort?.();
              } catch {
                // ignore
              }
            };
          }

          switch (event.type) {
            case LoginQRCallbackEventType.QRCodeGenerated: {
              const image = event.data.image.replace(/^data:image\/png;base64,/, "");
              current.qrDataUrl = image.startsWith("data:image")
                ? image
                : `data:image/png;base64,${image}`;
              break;
            }
            case LoginQRCallbackEventType.QRCodeExpired: {
              try {
                event.actions.retry();
              } catch {
                current.error = "QR expired before confirmation. Start login again.";
              }
              break;
            }
            case LoginQRCallbackEventType.QRCodeDeclined: {
              current.error = "QR login was declined on the phone.";
              break;
            }
            case LoginQRCallbackEventType.GotLoginInfo: {
              capturedCredentials = {
                imei: event.data.imei,
                cookie: event.data.cookie,
                userAgent: event.data.userAgent,
              };
              break;
            }
            default:
              break;
          }
        });

        const current = activeQrLogins.get(profile);
        if (!current || current.id !== login.id) {
          return;
        }

        if (!capturedCredentials) {
          const ctx = api.getContext();
          const cookieJar = api.getCookie();
          const cookieJson = cookieJar.toJSON();
          capturedCredentials = {
            imei: ctx.imei,
            cookie: cookieJson?.cookies ?? [],
            userAgent: ctx.userAgent,
            language: ctx.language,
          };
        }

        writeApiCredentials(profile, api, capturedCredentials ?? undefined);
        invalidateApi(profile);
        apiByProfile.set(profile, api);
        current.connected = true;
      } catch (error) {
        const current = activeQrLogins.get(profile);
        if (current && current.id === login.id) {
          current.error = toErrorMessage(error);
        }
      }
    })();

    activeQrLogins.set(profile, login);
  }

  const active = activeQrLogins.get(profile);
  if (!active) {
    return { message: "Failed to initialize Zalo QR login." };
  }

  const timeoutMs = Math.max(params.timeoutMs ?? DEFAULT_QR_START_TIMEOUT_MS, 3000);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (active.error) {
      resetQrLogin(profile);
      return {
        message: `Failed to start QR login: ${active.error}`,
      };
    }
    if (active.connected) {
      resetQrLogin(profile);
      return {
        message: "Zalo already connected.",
      };
    }
    if (active.qrDataUrl) {
      return {
        qrDataUrl: active.qrDataUrl,
        message: "Scan this QR with the Zalo app.",
      };
    }
    await delay(150);
  }

  return {
    message: "Still preparing QR. Call wait to continue checking login status.",
  };
}

export async function waitForZaloQrLogin(params: {
  profile?: string | null;
  timeoutMs?: number;
}): Promise<ZaloAuthStatus> {
  const profile = normalizeProfile(params.profile);
  const active = activeQrLogins.get(profile);

  if (!active) {
    const connected = await checkZaloAuthenticated(profile);
    return {
      connected,
      message: connected ? "Zalo session is ready." : "No active Zalo QR login in progress.",
    };
  }

  if (!isQrLoginFresh(active)) {
    resetQrLogin(profile);
    return {
      connected: false,
      message: "QR login expired. Start again to generate a fresh QR code.",
    };
  }

  const timeoutMs = Math.max(params.timeoutMs ?? DEFAULT_QR_WAIT_TIMEOUT_MS, 1000);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (active.error) {
      const message = `Zalo login failed: ${active.error}`;
      resetQrLogin(profile);
      return {
        connected: false,
        message,
      };
    }
    if (active.connected) {
      resetQrLogin(profile);
      return {
        connected: true,
        message: "Login successful.",
      };
    }
    await Promise.race([active.waitPromise, delay(400)]);
  }

  return {
    connected: false,
    message: "Still waiting for QR scan confirmation.",
  };
}

export async function logoutZaloProfile(profileInput?: string | null): Promise<{
  cleared: boolean;
  loggedOut: boolean;
  message: string;
}> {
  const profile = normalizeProfile(profileInput);
  resetQrLogin(profile);
  clearCachedGroupContext(profile);

  const listener = activeListeners.get(profile);
  if (listener) {
    try {
      listener.stop();
    } catch {
      // ignore
    }
    activeListeners.delete(profile);
  }

  invalidateApi(profile);
  const cleared = clearCredentials(profile);

  return {
    cleared,
    loggedOut: true,
    message: cleared ? "Logged out and cleared local session." : "No local session to clear.",
  };
}

export async function startZaloListener(params: {
  accountId: string;
  profile?: string | null;
  abortSignal: AbortSignal;
  onMessage: (message: ZaloInboundMessage) => void;
  onError: (error: Error) => void;
}): Promise<{ stop: () => void }> {
  const profile = normalizeProfile(params.profile);

  const existing = activeListeners.get(profile);
  if (existing) {
    throw new Error(
      `Zalo listener already running for profile "${profile}" (account "${existing.accountId}")`,
    );
  }

  const { api, ownUserId } = await withZaloApi(profile, async (api) => ({
    api,
    ownUserId: await resolveOwnUserId(api),
  }));
  let stopped = false;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let lastWatchdogTickAt = Date.now();

  const cleanup = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    try {
      api.listener.off("message", onMessage);
      api.listener.off("error", onError);
      api.listener.off("closed", onClosed);
    } catch {
      // ignore listener detachment errors
    }
    try {
      api.listener.stop();
    } catch {
      // ignore
    }
    activeListeners.delete(profile);
  };

  const onMessage = (incoming: Message) => {
    if (incoming.isSelf) {
      return;
    }
    const normalized = toInboundMessage(incoming, ownUserId);
    if (!normalized) {
      return;
    }
    params.onMessage(normalized);
  };

  const failListener = (error: Error) => {
    if (stopped || params.abortSignal.aborted) {
      return;
    }
    cleanup();
    invalidateApi(profile);
    params.onError(error);
  };

  const onError = (error: unknown) => {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    failListener(wrapped);
  };

  const onClosed = (code: number, reason: string) => {
    failListener(new Error(`Zalo listener closed (${code}): ${reason || "no reason"}`));
  };

  api.listener.on("message", onMessage);
  api.listener.on("error", onError);
  api.listener.on("closed", onClosed);

  try {
    api.listener.start({ retryOnClose: false });
  } catch (error) {
    cleanup();
    throw error;
  }

  watchdogTimer = setInterval(() => {
    if (stopped || params.abortSignal.aborted) {
      return;
    }
    const now = Date.now();
    const gapMs = now - lastWatchdogTickAt;
    lastWatchdogTickAt = now;
    if (gapMs <= LISTENER_WATCHDOG_MAX_GAP_MS) {
      return;
    }
    failListener(
      new Error(
        `Zalo listener watchdog gap detected (${Math.round(gapMs / 1000)}s): forcing reconnect`,
      ),
    );
  }, LISTENER_WATCHDOG_INTERVAL_MS);
  watchdogTimer.unref?.();

  params.abortSignal.addEventListener(
    "abort",
    () => {
      cleanup();
    },
    { once: true },
  );

  activeListeners.set(profile, {
    profile,
    accountId: params.accountId,
    stop: cleanup,
  });

  return { stop: cleanup };
}

export async function resolveZaloGroupsByEntries(params: {
  profile?: string | null;
  entries: string[];
}): Promise<Array<{ input: string; resolved: boolean; id?: string }>> {
  const groups = await listZaloGroups(params.profile);
  const byName = new Map<string, ZaloGroup[]>();
  for (const group of groups) {
    const key = normalizeOptionalLowercaseString(group.name);
    if (!key) {
      continue;
    }
    const list = byName.get(key) ?? [];
    list.push(group);
    byName.set(key, list);
  }

  return params.entries.map((input) => {
    const trimmed = input.trim();
    if (!trimmed) {
      return { input, resolved: false };
    }
    if (/^\d+$/.test(trimmed)) {
      return { input, resolved: true, id: trimmed };
    }
    const candidates = byName.get(normalizeLowercaseStringOrEmpty(trimmed)) ?? [];
    const match = candidates[0];
    return match ? { input, resolved: true, id: match.groupId } : { input, resolved: false };
  });
}

export async function resolveZaloAllowFromEntries(params: {
  profile?: string | null;
  entries: string[];
}): Promise<Array<{ input: string; resolved: boolean; id?: string; note?: string }>> {
  const friends = await listZaloFriends(params.profile);
  const byName = new Map<string, ZcaFriend[]>();
  for (const friend of friends) {
    const key = normalizeOptionalLowercaseString(friend.displayName);
    if (!key) {
      continue;
    }
    const list = byName.get(key) ?? [];
    list.push(friend);
    byName.set(key, list);
  }

  return params.entries.map((input) => {
    const trimmed = input.trim();
    if (!trimmed) {
      return { input, resolved: false };
    }
    if (/^\d+$/.test(trimmed)) {
      return { input, resolved: true, id: trimmed };
    }
    const matches = byName.get(normalizeLowercaseStringOrEmpty(trimmed)) ?? [];
    const match = matches[0];
    if (!match) {
      return { input, resolved: false };
    }
    return {
      input,
      resolved: true,
      id: match.userId,
      note: matches.length > 1 ? "multiple matches; chose first" : undefined,
    };
  });
}

export async function clearProfileRuntimeArtifacts(profileInput?: string | null): Promise<void> {
  const profile = normalizeProfile(profileInput);
  resetQrLogin(profile);
  clearCachedGroupContext(profile);
  const listener = activeListeners.get(profile);
  if (listener) {
    listener.stop();
    activeListeners.delete(profile);
  }
  invalidateApi(profile);
  await fsp.mkdir(resolveCredentialsDir(), { recursive: true }).catch(() => undefined);
}
