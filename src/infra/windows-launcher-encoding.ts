/** Encodes and decodes generated Windows launcher scripts (`.cmd` / `.vbs`). */
import iconv from "iconv-lite";
import {
  resolveWindowsOemCodePage,
  resolveWindowsOemCodePageForEncoding,
  resolveWindowsOemEncoding,
} from "./windows-encoding.js";

type WindowsLauncherScriptFormat = "cmd" | "vbs";

const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);

// Round-trip verification decoder choice: these DBCS labels match Windows in
// Node ICU, which also flags best-fit hazards (shift_jis ¥ -> 0x5C) iconv's
// decode would miss. euc-kr must not join them: Node ICU is KS X 1001 only,
// but Windows code page 949 is cp949/UHC, so ICU false-rejects the ~8,800 UHC
// extension syllables cmd.exe reads fine. The single-byte OEM `cp###` pages
// have no WHATWG decoder at all (ibm866 exists but disagrees with Windows
// CP866 at 0x1A/0x1C/0x7F); iconv's own decode is safe for them because
// iconv-lite never best-fits — unmappable characters become "?" and fail the
// round-trip check.
const WHATWG_VERIFIABLE_ENCODINGS = new Set(["gbk", "big5", "shift_jis", "windows-874"]);

// Code-page cmd launchers record their encoding in this ASCII comment line so
// readback never has to guess: some code-page byte sequences are also valid
// UTF-8 (GBK "隆" is C2 A1, which UTF-8 reads as "¡"), so content sniffing
// silently corrupts paths.
const LAUNCHER_ENCODING_MARKER_PREFIX = "@rem openclaw-launcher-encoding=";
const LAUNCHER_ENCODING_MARKER_RE = /^@rem openclaw-launcher-encoding=(\S+)\s*$/;
const LAUNCHER_CODEPAGE_PREAMBLE_RE = /^@chcp \d+ >nul\s*$/;

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
 * .cmd in the console (OEM) code page; plain UTF-8 garbles non-ASCII profile
 * paths into "file not found" launch failures (#107416, #108774). Do not
 * simplify back to utf8.
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
    if (process.platform === "win32") {
      const codePage = resolveWindowsOemCodePage();
      if (codePage === null || codePage === 864) {
        throw new Error(
          "Windows cmd launcher script cannot be written safely because the Windows OEM code page is unavailable or remaps ASCII syntax.",
        );
      }
    }
    // ASCII bytes are identical in UTF-8 and every Windows code page; keep the
    // legacy byte-for-byte output on syntax-compatible OEM pages.
    return Buffer.from(params.content, "utf8");
  }
  const encoding = resolveWindowsOemEncoding();
  if (!encoding || !iconv.encodingExists(encoding)) {
    throw new Error(
      "Windows cmd launcher script contains non-ASCII content, but the Windows OEM code page is unavailable or unsupported; writing UTF-8 would make cmd.exe misread the script. Switch Windows to UTF-8 (code page 65001) or remove the non-ASCII content.",
    );
  }
  const codePage = resolveWindowsOemCodePageForEncoding(encoding);
  if (codePage === null) {
    return Buffer.from(params.content, "utf8");
  }
  // The ASCII first line makes inherited and per-user console overrides adopt
  // the file's OEM page before cmd.exe reads any non-ASCII launcher content.
  const marked = `@chcp ${codePage} >nul\r\n${LAUNCHER_ENCODING_MARKER_PREFIX}${encoding}\r\n${params.content}`;
  const encoded = iconv.encode(marked, encoding);
  // iconv-lite substitutes "?" for unmappable characters, which would silently
  // corrupt paths; verify the round-trip and fail the install before any
  // launcher file is written. See WHATWG_VERIFIABLE_ENCODINGS for the decoder
  // split between Node ICU and iconv.
  const decoded = WHATWG_VERIFIABLE_ENCODINGS.has(encoding)
    ? new TextDecoder(encoding).decode(encoded)
    : iconv.decode(encoded, encoding);
  // Windows decodes CP1258 with MB_PRECOMPOSED by default. Reject composite
  // sequences that Windows would normalize into a different path or value.
  const windowsWouldPrecompose =
    encoding === "windows-1258" && decoded.normalize("NFC") !== decoded;
  if (decoded !== marked || windowsWouldPrecompose) {
    throw new Error(
      `Windows ${params.format} launcher script contains characters that cannot be represented in the Windows console code page (${encoding}); cmd.exe would misread the script. Remove those characters or switch Windows to UTF-8 (code page 65001).`,
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
  // Preamble and marker lines are pure ASCII; supported code pages keep 0x0A
  // out of multibyte trail positions. Accept marker-only files written before
  // the preamble was added, too.
  let markerStart = 0;
  let newlineIndex = buffer.indexOf(0x0a);
  if (
    newlineIndex !== -1 &&
    LAUNCHER_CODEPAGE_PREAMBLE_RE.test(buffer.subarray(0, newlineIndex).toString("latin1"))
  ) {
    markerStart = newlineIndex + 1;
    newlineIndex = buffer.indexOf(0x0a, markerStart);
  }
  if (newlineIndex !== -1) {
    const marker = LAUNCHER_ENCODING_MARKER_RE.exec(
      buffer.subarray(markerStart, newlineIndex).toString("latin1"),
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
