/** Encodes and decodes generated Windows launcher scripts (`.cmd` / `.vbs`). */
import iconv from "iconv-lite";
import { resolveWindowsSystemEncoding } from "./windows-encoding.js";

type WindowsLauncherScriptFormat = "cmd" | "vbs";

const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);

// cmd.exe decodes batch files with the console OEM code page, which matches the
// ANSI code page only on these locales. windows-125x hosts pair ANSI with a
// separate OEM page (437/850/852/866/...) that WHATWG decoders cannot model, so
// non-ASCII cmd content stays UTF-8 there instead of guessing wrong bytes.
const CMD_ANSI_EQUALS_OEM_ENCODINGS = new Set([
  "gbk",
  "big5",
  "shift_jis",
  "euc-kr",
  "gb18030",
  "windows-874",
]);

// Code-page cmd launchers record their encoding in this ASCII comment line so
// readback never has to guess: some code-page byte sequences are also valid
// UTF-8 (GBK "隆" is C2 A1, which UTF-8 reads as "¡"), so content sniffing
// silently corrupts paths.
const LAUNCHER_ENCODING_MARKER_PREFIX = "@rem openclaw-launcher-encoding=";
const LAUNCHER_ENCODING_MARKER_RE = /^@rem openclaw-launcher-encoding=(\S+)\s*$/;

function isAsciiOnly(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) {
      return false;
    }
  }
  return true;
}

/**
 * wscript.exe reads .vbs only as ANSI or UTF-16 LE with BOM, and cmd.exe reads
 * .cmd in the console code page; plain UTF-8 garbles CJK profile paths into
 * "file not found" launch failures (#107416). Do not simplify back to utf8.
 */
export function encodeWindowsLauncherScript(params: {
  format: WindowsLauncherScriptFormat;
  content: string;
}): Buffer {
  if (params.format === "vbs") {
    // UTF-16 LE with BOM is the one wscript encoding that works on every locale.
    return Buffer.concat([UTF16LE_BOM, Buffer.from(params.content, "utf16le")]);
  }
  if (isAsciiOnly(params.content)) {
    // ASCII bytes are identical in UTF-8 and every Windows code page; keep the
    // legacy byte-for-byte output so non-CJK installs see no change.
    return Buffer.from(params.content, "utf8");
  }
  const encoding = resolveWindowsSystemEncoding();
  if (
    !encoding ||
    !CMD_ANSI_EQUALS_OEM_ENCODINGS.has(encoding) ||
    !iconv.encodingExists(encoding)
  ) {
    return Buffer.from(params.content, "utf8");
  }
  // Generated launcher scripts are CRLF-terminated throughout; the marker is
  // ASCII, so it encodes byte-identically in every safe code page.
  const marked = `${LAUNCHER_ENCODING_MARKER_PREFIX}${encoding}\r\n${params.content}`;
  const encoded = iconv.encode(marked, encoding);
  // iconv-lite substitutes "?" for unmappable characters, which would silently
  // corrupt paths; verify the round-trip and fail the install before any
  // launcher file is written. Node ICU's euc-kr decoder is KS X 1001 only, but
  // Windows code page 949 is cp949/UHC, so ICU false-rejects the ~8,800 UHC
  // extension syllables cmd.exe reads fine — verify euc-kr with iconv's own
  // cp949 decode instead. The other five labels match Windows in ICU, which
  // also flags best-fit hazards (shift_jis ¥ -> 0x5C) iconv's decode would miss.
  const decoded =
    encoding === "euc-kr"
      ? iconv.decode(encoded, encoding)
      : new TextDecoder(encoding).decode(encoded);
  if (decoded !== marked) {
    throw new Error(
      `Windows ${params.format} launcher script contains characters that cannot be represented in the Windows system code page (${encoding}); cmd.exe would misread the script. Remove those characters or switch Windows to UTF-8 (code page 65001).`,
    );
  }
  return encoded;
}

/** Decodes launcher scripts written by any OpenClaw version (UTF-16 LE BOM, marked code page, or UTF-8). */
export function decodeWindowsLauncherScript(params: { buffer: Buffer }): string {
  const { buffer } = params;
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  // The marker line is pure ASCII and no CMD_ANSI_EQUALS_OEM_ENCODINGS multibyte
  // sequence contains 0x0A, so the first newline in a marked file is exactly
  // the marker terminator. latin1 (not "ascii", which masks the high bit and
  // could alias garbage bytes into the prefix) keeps the byte-level read exact.
  const newlineIndex = buffer.indexOf(0x0a);
  if (newlineIndex !== -1) {
    const marker = LAUNCHER_ENCODING_MARKER_RE.exec(
      buffer.subarray(0, newlineIndex).toString("latin1"),
    );
    // encodingExists guards hand-edited marker labels so a bad label degrades
    // to the UTF-8 fallback instead of iconv.decode throwing mid-poll.
    if (marker?.[1] && iconv.encodingExists(marker[1])) {
      return iconv.decode(buffer.subarray(newlineIndex + 1), marker[1]);
    }
  }
  // No marker: ASCII scripts and pre-marker legacy UTF-8 installs.
  return buffer.toString("utf8");
}
