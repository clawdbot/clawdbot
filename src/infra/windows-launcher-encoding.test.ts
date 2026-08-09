// Covers Windows launcher script encoding for wscript/cmd code page contracts (#107416, #108774).
import iconv from "iconv-lite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeWindowsLauncherScript,
  encodeWindowsLauncherScript,
} from "./windows-launcher-encoding.js";

const resolveWindowsOemEncodingMock = vi.hoisted(() => vi.fn((): string | null => null));
const resolveWindowsOemCodePageMock = vi.hoisted(() => vi.fn((): number | null => null));

vi.mock("./windows-encoding.js", async () => {
  const actual =
    await vi.importActual<typeof import("./windows-encoding.js")>("./windows-encoding.js");
  return {
    ...actual,
    resolveWindowsOemCodePage: () => resolveWindowsOemCodePageMock(),
    resolveWindowsOemEncoding: () => resolveWindowsOemEncodingMock(),
  };
});

const CJK_SCRIPT_PATH = "C:\\Users\\苗振\\.openclaw\\gateway.cmd";
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);
const marker = (codePage: number, encoding: string) =>
  `@chcp ${codePage} >nul\r\n@rem openclaw-launcher-encoding=${encoding}\r\n`;
const GBK_MARKER = marker(936, "gbk");
const EUC_KR_MARKER = marker(949, "euc-kr");
const CP857_MARKER = marker(857, "cp857");
const CP850_MARKER = marker(850, "cp850");
const UTF8_MARKER = marker(65001, "utf-8");

beforeEach(() => {
  resolveWindowsOemEncodingMock.mockReset();
  resolveWindowsOemEncodingMock.mockReturnValue(null);
  resolveWindowsOemCodePageMock.mockReset();
  resolveWindowsOemCodePageMock.mockReturnValue(437);
});

afterEach(() => {
  vi.restoreAllMocks();
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
    expect(resolveWindowsOemEncodingMock).not.toHaveBeenCalled();
  });

  it("fails closed for ASCII cmd syntax on OEMCP 864", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    resolveWindowsOemCodePageMock.mockReturnValue(864);
    const content = "@echo off\r\necho %PATH%\r\n";

    expect(() => encodeWindowsLauncherScript({ format: "cmd", content })).toThrow(
      /remaps ASCII syntax/,
    );
  });

  it("encodes non-ASCII cmd scripts with a code-page preamble and marker", () => {
    resolveWindowsOemEncodingMock.mockReturnValue("gbk");
    const content = `@echo off\r\ncd /d "C:\\Users\\苗振\\.openclaw"\r\nnode gateway.js\r\n`;
    const encoded = encodeWindowsLauncherScript({ format: "cmd", content });

    expect(encoded.equals(Buffer.from(content, "utf8"))).toBe(false);
    expect(encoded.equals(iconv.encode(GBK_MARKER + content, "gbk"))).toBe(true);
    expect(encoded.subarray(0, "@chcp 936 >nul\r\n".length).toString("ascii")).toBe(
      "@chcp 936 >nul\r\n",
    );
    expect(decodeWindowsLauncherScript({ buffer: encoded })).toBe(content);
  });

  it("round-trips cmd content whose GBK bytes are also valid UTF-8 (隆 -> C2 A1 -> ¡)", () => {
    resolveWindowsOemEncodingMock.mockReturnValue("gbk");
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
    resolveWindowsOemEncodingMock.mockReturnValue("euc-kr");
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

  it("encodes Turkish profile paths with the cp857 OEM page cmd.exe reads (#108774)", () => {
    resolveWindowsOemEncodingMock.mockReturnValue("cp857");
    const content = `@echo off\r\ncd /d "C:\\Users\\Yiğit Öğün\\.openclaw"\r\nnode gateway.js\r\n`;
    const encoded = encodeWindowsLauncherScript({ format: "cmd", content });

    expect(encoded.equals(Buffer.from(content, "utf8"))).toBe(false);
    expect(encoded.equals(iconv.encode(CP857_MARKER + content, "cp857"))).toBe(true);
    expect(decodeWindowsLauncherScript({ buffer: encoded })).toBe(content);
  });

  it("encodes Western European profile paths with the cp850 OEM page", () => {
    resolveWindowsOemEncodingMock.mockReturnValue("cp850");
    const content = '@echo off\r\ncd /d "C:\\Users\\café"\r\nnode gateway.js\r\n';
    const encoded = encodeWindowsLauncherScript({ format: "cmd", content });

    expect(encoded.equals(iconv.encode(CP850_MARKER + content, "cp850"))).toBe(true);
    expect(decodeWindowsLauncherScript({ buffer: encoded })).toBe(content);
  });

  it("fails closed when no OEM code page is available", () => {
    const content = `@echo off\r\ncd /d "C:\\Users\\苗振"\r\n`;

    expect(() => encodeWindowsLauncherScript({ format: "cmd", content })).toThrow(
      /OEM code page is unavailable or unsupported/,
    );
  });

  it("declares UTF-8 when the boot OEM page is 65001", () => {
    resolveWindowsOemEncodingMock.mockReturnValue("utf-8");
    const content = '@echo off\r\ncd /d "C:\\Users\\café"\r\n';
    const encoded = encodeWindowsLauncherScript({ format: "cmd", content });

    expect(encoded.equals(Buffer.from(UTF8_MARKER + content, "utf8"))).toBe(true);
    expect(decodeWindowsLauncherScript({ buffer: encoded })).toBe(content);
  });

  it("allows only Windows-1258 content that round-trips exactly", () => {
    resolveWindowsOemEncodingMock.mockReturnValue("windows-1258");
    const supported = '@echo off\r\ncd /d "C:\\Users\\Đăng"\r\n';
    const unsupported = '@echo off\r\ncd /d "C:\\Users\\Việt"\r\n';
    const decomposed = '@echo off\r\ncd /d "C:\\Users\\e\u0323"\r\n';

    expect(
      decodeWindowsLauncherScript({
        buffer: encodeWindowsLauncherScript({ format: "cmd", content: supported }),
      }),
    ).toBe(supported);
    expect(() => encodeWindowsLauncherScript({ format: "cmd", content: unsupported })).toThrow(
      /cannot be represented/,
    );
    expect(() => encodeWindowsLauncherScript({ format: "cmd", content: decomposed })).toThrow(
      /cannot be represented/,
    );
  });

  it("fails the install instead of writing unrepresentable cmd content", () => {
    resolveWindowsOemEncodingMock.mockReturnValue("gbk");
    const content = '@echo off\r\nset "OC_LABEL=🚀"\r\n';

    expect(() => encodeWindowsLauncherScript({ format: "cmd", content })).toThrow(
      /cannot be represented in the Windows console code page \(gbk\)/,
    );
  });

  it("fails the install for characters outside the single-byte OEM page", () => {
    resolveWindowsOemEncodingMock.mockReturnValue("cp857");
    const content = `@echo off\r\ncd /d "C:\\Users\\苗振"\r\n`;

    expect(() => encodeWindowsLauncherScript({ format: "cmd", content })).toThrow(
      /cannot be represented in the Windows console code page \(cp857\)/,
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

  it("decodes pre-preamble marked code-page scripts", () => {
    const content = "@echo off\r\nrem 你好\r\n";
    const buffer = iconv.encode(`@rem openclaw-launcher-encoding=gbk\r\n${content}`, "gbk");

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
