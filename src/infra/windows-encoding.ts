// Detects Windows console/OEM code pages and decodes console output encodings.
import { spawnSync } from "node:child_process";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { getWindowsCmdExePath, queryWindowsRegistryValue } from "./windows-install-roots.js";

const WINDOWS_CODEPAGE_ENCODING_MAP: Record<number, string> = {
  65001: "utf-8",
  54936: "gb18030",
  874: "windows-874",
  936: "gbk",
  950: "big5",
  932: "shift_jis",
  949: "euc-kr",
  1250: "windows-1250",
  1251: "windows-1251",
  1252: "windows-1252",
  1253: "windows-1253",
  1254: "windows-1254",
  1255: "windows-1255",
  1256: "windows-1256",
  1257: "windows-1257",
  1258: "windows-1258",
};
const WINDOWS_ENCODING_PROBE_TIMEOUT_MS = 5_000;

// Task Scheduler launchers use the system OEM page. Interactive consoles can
// override it, so generated scripts also declare this page before their body.
const WINDOWS_NLS_CODEPAGE_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage";

const WINDOWS_OEM_CODEPAGE_ENCODING_MAP: Record<number, string> = {
  65001: "utf-8",
  // These locales use the same ANSI/OEM identifier; labels match the ANSI map.
  874: "windows-874",
  932: "shift_jis",
  936: "gbk",
  949: "euc-kr",
  950: "big5",
  1258: "windows-1258",
  // OEM-only single-byte pages used by windows-125x ANSI hosts, iconv-lite
  // `cp###` labels. 864 is omitted: real CP864 repurposes ASCII 0x25 "%",
  // which generated cmd scripts contain. Unsupported OEM pages fail closed.
  437: "cp437",
  720: "cp720",
  737: "cp737",
  775: "cp775",
  850: "cp850",
  852: "cp852",
  855: "cp855",
  857: "cp857",
  858: "cp858",
  860: "cp860",
  861: "cp861",
  862: "cp862",
  863: "cp863",
  865: "cp865",
  866: "cp866",
  869: "cp869",
};
const WINDOWS_OEM_ENCODING_CODEPAGE_MAP = new Map(
  Object.entries(WINDOWS_OEM_CODEPAGE_ENCODING_MAP).map(([codePage, encoding]) => [
    encoding,
    Number.parseInt(codePage, 10),
  ]),
);

let cachedWindowsConsoleEncoding: string | null | undefined;
let cachedWindowsSystemEncoding: string | null | undefined;
let cachedWindowsOemCodePage: number | null | undefined;

/** Extracts a Windows console code page number from localized `chcp` output. */
function parseWindowsCodePage(raw: string): number | null {
  if (!raw) {
    return null;
  }
  const match = raw.match(/\b(\d{3,5})\b/);
  if (!match?.[1]) {
    return null;
  }
  const codePage = Number.parseInt(match[1], 10);
  if (!Number.isFinite(codePage) || codePage <= 0) {
    return null;
  }
  return codePage;
}

/** Resolves and caches the current Windows console encoding for subprocess output. */
export function resolveWindowsConsoleEncoding(): string | null {
  if (process.platform !== "win32") {
    return null;
  }
  if (cachedWindowsConsoleEncoding !== undefined) {
    return cachedWindowsConsoleEncoding;
  }
  try {
    const result = spawnSync(getWindowsCmdExePath(), ["/d", "/s", "/c", "chcp"], {
      windowsHide: true,
      encoding: "utf8",
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: WINDOWS_ENCODING_PROBE_TIMEOUT_MS,
    });
    const raw = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const codePage = parseWindowsCodePage(raw);
    cachedWindowsConsoleEncoding =
      codePage !== null ? (WINDOWS_CODEPAGE_ENCODING_MAP[codePage] ?? null) : null;
  } catch {
    cachedWindowsConsoleEncoding = null;
  }
  return cachedWindowsConsoleEncoding;
}

/** Resolves and caches the Windows system encoding used by legacy text files. */
function resolveWindowsSystemEncoding(): string | null {
  if (process.platform !== "win32") {
    return null;
  }
  if (cachedWindowsSystemEncoding !== undefined) {
    return cachedWindowsSystemEncoding;
  }
  try {
    const result = spawnSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Text.Encoding]::Default.CodePage"],
      {
        windowsHide: true,
        encoding: "utf8",
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: WINDOWS_ENCODING_PROBE_TIMEOUT_MS,
      },
    );
    const raw = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const codePage = parseWindowsCodePage(raw);
    cachedWindowsSystemEncoding =
      codePage !== null ? (WINDOWS_CODEPAGE_ENCODING_MAP[codePage] ?? null) : null;
  } catch {
    cachedWindowsSystemEncoding = null;
  }
  return cachedWindowsSystemEncoding;
}

/** Resolves and caches the boot-time Windows OEM encoding cmd.exe reads batch files with. */
export function resolveWindowsOemEncoding(): string | null {
  const codePage = resolveWindowsOemCodePage();
  return codePage !== null ? (WINDOWS_OEM_CODEPAGE_ENCODING_MAP[codePage] ?? null) : null;
}

/** Resolves and caches the numeric boot-time Windows OEM code page. */
export function resolveWindowsOemCodePage(): number | null {
  if (process.platform !== "win32") {
    return null;
  }
  if (cachedWindowsOemCodePage !== undefined) {
    return cachedWindowsOemCodePage;
  }
  const raw = queryWindowsRegistryValue(WINDOWS_NLS_CODEPAGE_KEY, "OEMCP");
  cachedWindowsOemCodePage = raw === null ? null : parseWindowsCodePage(raw);
  return cachedWindowsOemCodePage;
}

/** Returns the numeric Windows OEM page for one resolver encoding label. */
export function resolveWindowsOemCodePageForEncoding(encoding: string): number | null {
  return WINDOWS_OEM_ENCODING_CODEPAGE_MAP.get(encoding) ?? null;
}

/** Decodes one complete subprocess output buffer, preferring valid UTF-8 before legacy code pages. */
export function decodeWindowsOutputBuffer(params: {
  buffer: Buffer;
  platform?: NodeJS.Platform;
  windowsEncoding?: string | null;
}): string {
  return decodeWindowsBufferWithFallback({
    ...params,
    resolveFallbackEncoding: () => params.windowsEncoding ?? resolveWindowsConsoleEncoding(),
  });
}

/** Decodes a text file, preferring valid UTF-8 before the Windows system encoding. */
export function decodeWindowsTextFileBuffer(params: {
  buffer: Buffer;
  platform?: NodeJS.Platform;
  windowsEncoding?: string | null;
}): string {
  return decodeWindowsBufferWithFallback({
    ...params,
    resolveFallbackEncoding: () => params.windowsEncoding ?? resolveWindowsSystemEncoding(),
  });
}

function decodeWindowsBufferWithFallback(params: {
  buffer: Buffer;
  platform?: NodeJS.Platform;
  resolveFallbackEncoding: () => string | null;
}): string {
  const platform = params.platform ?? process.platform;
  if (platform !== "win32") {
    return params.buffer.toString("utf8");
  }

  const utf8 = decodeStrictUtf8(params.buffer);
  if (utf8 !== null) {
    return utf8;
  }

  const encoding = params.resolveFallbackEncoding();
  if (!encoding || normalizeLowercaseStringOrEmpty(encoding) === "utf-8") {
    return params.buffer.toString("utf8");
  }
  try {
    return new TextDecoder(encoding).decode(params.buffer);
  } catch {
    return params.buffer.toString("utf8");
  }
}

/** Creates a streaming decoder for subprocess output chunks that may split multibyte characters. */
export function createWindowsOutputDecoder(params?: {
  platform?: NodeJS.Platform;
  windowsEncoding?: string | null;
}): {
  decode(chunk: Buffer | string): string;
  flush(): string;
} {
  const platform = params?.platform ?? process.platform;
  const encoding =
    platform === "win32" ? (params?.windowsEncoding ?? resolveWindowsConsoleEncoding()) : null;
  const normalizedEncoding = normalizeLowercaseStringOrEmpty(encoding);
  const legacyDecoder =
    platform === "win32" && encoding && normalizedEncoding !== "utf-8"
      ? new TextDecoder(encoding)
      : null;
  const utf8Decoder =
    platform === "win32" && legacyDecoder ? new TextDecoder("utf-8", { fatal: true }) : null;
  const streamingUtf8Decoder = legacyDecoder ? null : new TextDecoder("utf-8");
  let useLegacyDecoder = false;
  let pendingUtf8Bytes = Buffer.alloc(0);

  return {
    decode(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!legacyDecoder || !utf8Decoder) {
        return streamingUtf8Decoder?.decode(buffer, { stream: true }) ?? "";
      }
      if (useLegacyDecoder) {
        return legacyDecoder.decode(buffer, { stream: true });
      }
      // Stay on strict UTF-8 until it fails; replay any pending lead bytes through the legacy
      // decoder so split GBK/Big5/etc. characters are not lost at the fallback boundary.
      const replayBuffer =
        pendingUtf8Bytes.length > 0 ? Buffer.concat([pendingUtf8Bytes, buffer]) : buffer;
      try {
        const decoded = utf8Decoder.decode(buffer, { stream: true });
        pendingUtf8Bytes = Buffer.from(getTrailingIncompleteUtf8Bytes(replayBuffer));
        return decoded;
      } catch {
        useLegacyDecoder = true;
        pendingUtf8Bytes = Buffer.alloc(0);
        return legacyDecoder.decode(replayBuffer, { stream: true });
      }
    },
    flush() {
      if (!legacyDecoder || !utf8Decoder) {
        return streamingUtf8Decoder?.decode() ?? "";
      }
      if (useLegacyDecoder) {
        return legacyDecoder.decode();
      }
      try {
        const decoded = utf8Decoder.decode();
        pendingUtf8Bytes = Buffer.alloc(0);
        return decoded;
      } catch {
        useLegacyDecoder = true;
        const replayBuffer = pendingUtf8Bytes;
        pendingUtf8Bytes = Buffer.alloc(0);
        return replayBuffer.length > 0 ? legacyDecoder.decode(replayBuffer) : "";
      }
    },
  };
}

function getTrailingIncompleteUtf8Bytes(buffer: Buffer): Buffer {
  let index = buffer.length - 1;
  let continuationBytes = 0;
  while (index >= 0 && continuationBytes < 3) {
    const byte = buffer.at(index);
    if (byte === undefined || byte < 0x80 || byte > 0xbf) {
      break;
    }
    continuationBytes += 1;
    index -= 1;
  }
  if (index < 0) {
    return buffer;
  }

  const leadByte = buffer.at(index);
  if (leadByte === undefined) {
    return Buffer.alloc(0);
  }
  const sequenceLength = getUtf8SequenceLength(leadByte);
  if (sequenceLength <= 1) {
    return Buffer.alloc(0);
  }

  const availableBytes = continuationBytes + 1;
  return availableBytes < sequenceLength ? buffer.subarray(index) : Buffer.alloc(0);
}

function getUtf8SequenceLength(byte: number): number {
  if (byte >= 0xc2 && byte <= 0xdf) {
    return 2;
  }
  if (byte >= 0xe0 && byte <= 0xef) {
    return 3;
  }
  if (byte >= 0xf0 && byte <= 0xf4) {
    return 4;
  }
  return 1;
}

function decodeStrictUtf8(buffer: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}
