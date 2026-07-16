// Covers Windows launcher script encoding for wscript/cmd code page contracts (#107416).
import iconv from "iconv-lite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeWindowsLauncherScript,
  encodeWindowsLauncherScript,
} from "./windows-launcher-encoding.js";

const resolveWindowsSystemEncodingMock = vi.hoisted(() => vi.fn((): string | null => null));

vi.mock("./windows-encoding.js", async () => {
  const actual =
    await vi.importActual<typeof import("./windows-encoding.js")>("./windows-encoding.js");
  return {
    ...actual,
    resolveWindowsSystemEncoding: () => resolveWindowsSystemEncodingMock(),
  };
});

const CJK_SCRIPT_PATH = "C:\\Users\\苗振\\.openclaw\\gateway.cmd";
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);
const GBK_MARKER = "@rem openclaw-launcher-encoding=gbk\r\n";
const EUC_KR_MARKER = "@rem openclaw-launcher-encoding=euc-kr\r\n";

beforeEach(() => {
  resolveWindowsSystemEncodingMock.mockReset();
  resolveWindowsSystemEncodingMock.mockReturnValue(null);
});

describe("encodeWindowsLauncherScript", () => {
  it("writes vbs scripts as UTF-16 LE with BOM including CJK paths", () => {
    const content = `CreateObject("WScript.Shell").Run """${CJK_SCRIPT_PATH}""", 0, False\r\n`;
    const encoded = encodeWindowsLauncherScript({ format: "vbs", content });

    expect(encoded.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect(encoded.subarray(2).toString("utf16le")).toBe(content);
  });

  it("writes vbs scripts as UTF-16 LE even for pure-ASCII content", () => {
    const content = 'CreateObject("WScript.Shell").Run """C:\\gw.cmd""", 0, False\r\n';
    const encoded = encodeWindowsLauncherScript({ format: "vbs", content });

    expect(encoded.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect(encoded.subarray(2).toString("utf16le")).toBe(content);
  });

  it("keeps ASCII cmd scripts byte-identical without resolving a code page", () => {
    const content = '@echo off\r\ncd /d "C:\\temp"\r\nnode gateway.js\r\n';
    const encoded = encodeWindowsLauncherScript({ format: "cmd", content });

    expect(encoded.equals(Buffer.from(content, "utf8"))).toBe(true);
    expect(resolveWindowsSystemEncodingMock).not.toHaveBeenCalled();
  });

  it("encodes non-ASCII cmd scripts with a marker line plus CJK code page bytes", () => {
    resolveWindowsSystemEncodingMock.mockReturnValue("gbk");
    const content = `@echo off\r\ncd /d "C:\\Users\\苗振\\.openclaw"\r\nnode gateway.js\r\n`;
    const encoded = encodeWindowsLauncherScript({ format: "cmd", content });

    expect(encoded.equals(Buffer.from(content, "utf8"))).toBe(false);
    expect(encoded.equals(iconv.encode(GBK_MARKER + content, "gbk"))).toBe(true);
    expect(decodeWindowsLauncherScript({ buffer: encoded })).toBe(content);
  });

  it("round-trips cmd content whose GBK bytes are also valid UTF-8 (隆 -> C2 A1 -> ¡)", () => {
    resolveWindowsSystemEncodingMock.mockReturnValue("gbk");
    // Verify the trap on this iconv build: valid UTF-8, wrong string, no U+FFFD.
    const collisionBytes = iconv.encode("隆", "gbk");
    expect(collisionBytes.toString("utf8")).not.toBe("隆");
    expect(collisionBytes.toString("utf8")).not.toContain(REPLACEMENT_CHAR);

    const content = `@echo off\r\ncd /d "C:\\Users\\隆\\.openclaw"\r\nnode gateway.js\r\n`;
    const encoded = encodeWindowsLauncherScript({ format: "cmd", content });

    expect(encoded.equals(iconv.encode(GBK_MARKER + content, "gbk"))).toBe(true);
    // Locks the regression: a raw UTF-8 readback of these bytes decodes
    // cleanly (no replacement char) yet corrupts the path — the pre-marker bug.
    expect(encoded.toString("utf8")).not.toContain(REPLACEMENT_CHAR);
    expect(encoded.toString("utf8")).not.toContain("隆");
    expect(decodeWindowsLauncherScript({ buffer: encoded })).toBe(content);
  });

  it("encodes cp949 extension syllables that Node ICU's euc-kr decoder rejects", () => {
    resolveWindowsSystemEncodingMock.mockReturnValue("euc-kr");
    // Windows code page 949 is cp949/UHC; "똠" (8C 63) is a UHC extension syllable
    // iconv encodes and round-trips, but new TextDecoder("euc-kr") cannot decode
    // (KS X 1001 only). The guard must verify euc-kr with iconv, not ICU.
    const extensionBytes = iconv.encode("똠", "euc-kr");
    expect(iconv.decode(extensionBytes, "euc-kr")).toBe("똠");
    expect(new TextDecoder("euc-kr").decode(extensionBytes)).not.toBe("똠");

    const content = `@echo off\r\ncd /d "C:\\Users\\똠이\\.openclaw"\r\nnode gateway.js\r\n`;
    const encoded = encodeWindowsLauncherScript({ format: "cmd", content });

    expect(encoded.equals(iconv.encode(EUC_KR_MARKER + content, "euc-kr"))).toBe(true);
    expect(decodeWindowsLauncherScript({ buffer: encoded })).toBe(content);
  });

  it("falls back to UTF-8 when no system code page is available", () => {
    const content = `@echo off\r\ncd /d "C:\\Users\\苗振"\r\n`;
    const encoded = encodeWindowsLauncherScript({ format: "cmd", content });

    expect(encoded.equals(Buffer.from(content, "utf8"))).toBe(true);
  });

  it("falls back to UTF-8 on windows-125x hosts whose console page differs from ANSI", () => {
    resolveWindowsSystemEncodingMock.mockReturnValue("windows-1252");
    const content = '@echo off\r\ncd /d "C:\\Users\\café"\r\n';
    const encoded = encodeWindowsLauncherScript({ format: "cmd", content });

    expect(encoded.equals(Buffer.from(content, "utf8"))).toBe(true);
  });

  it("fails the install instead of writing unrepresentable cmd content", () => {
    resolveWindowsSystemEncodingMock.mockReturnValue("gbk");
    const content = '@echo off\r\nset "OC_LABEL=🚀"\r\n';

    expect(() => encodeWindowsLauncherScript({ format: "cmd", content })).toThrow(
      /cannot be represented in the Windows system code page \(gbk\)/,
    );
  });
});

describe("decodeWindowsLauncherScript", () => {
  it("strips the UTF-16 LE BOM and decodes vbs scripts", () => {
    const content = `CreateObject("WScript.Shell").Run """${CJK_SCRIPT_PATH}""", 0, False\r\n`;
    const buffer = encodeWindowsLauncherScript({ format: "vbs", content });

    expect(decodeWindowsLauncherScript({ buffer })).toBe(content);
  });

  it("decodes unmarked legacy UTF-8 scripts with CJK paths", () => {
    const content = `@echo off\r\ncd /d "C:\\Users\\苗振\\.openclaw"\r\nnode gateway.js\r\n`;
    const buffer = Buffer.from(content, "utf8");

    expect(decodeWindowsLauncherScript({ buffer })).toBe(content);
  });

  it("decodes marked code-page scripts with the recorded encoding", () => {
    const content = "@echo off\r\nrem 你好\r\n";
    const buffer = iconv.encode(GBK_MARKER + content, "gbk");

    expect(decodeWindowsLauncherScript({ buffer })).toBe(content);
  });

  it("falls back to UTF-8 for marker labels iconv cannot decode", () => {
    const content = "@rem openclaw-launcher-encoding=bogus\r\nnode gateway.js\r\n";
    const buffer = Buffer.from(content, "utf8");

    expect(decodeWindowsLauncherScript({ buffer })).toBe(content);
  });

  it("degrades unmarked non-UTF-8 bytes to UTF-8 replacement output", () => {
    // Unmarked code-page files were never produced by a shipped release (the
    // code-page writer ships together with the marker), so deterministic UTF-8
    // is the correct total behavior for everything without a marker.
    const buffer = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);

    expect(decodeWindowsLauncherScript({ buffer })).toContain(REPLACEMENT_CHAR);
  });
});
