// Covers Windows command-output code page parsing and decoding.

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const queryWindowsRegistryValueMock = vi.hoisted(() => vi.fn((): string | null => null));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawnSync: spawnSyncMock,
  };
});

vi.mock("./windows-install-roots.js", async () => {
  const actual = await vi.importActual<typeof import("./windows-install-roots.js")>(
    "./windows-install-roots.js",
  );
  return {
    ...actual,
    queryWindowsRegistryValue: queryWindowsRegistryValueMock,
  };
});

import {
  createWindowsOutputDecoder,
  decodeWindowsOutputBuffer,
  decodeWindowsTextFileBuffer,
} from "./windows-encoding.js";

const UTF16_OUTPUT_CASES = [
  ["UTF-16LE", Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00, 0x0a, 0x00])],
  ["UTF-16BE", Buffer.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69, 0x00, 0x0a])],
] as const;

describe("windows output encoding", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    spawnSyncMock.mockReset();
    queryWindowsRegistryValueMock.mockReset();
  });

  it("maps every supported boot-time OEM code page", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const mappings = [
      [65001, "utf-8"],
      [874, "windows-874"],
      [932, "shift_jis"],
      [936, "gbk"],
      [949, "euc-kr"],
      [950, "big5"],
      [1258, "windows-1258"],
      [437, "cp437"],
      [720, "cp720"],
      [737, "cp737"],
      [775, "cp775"],
      [850, "cp850"],
      [852, "cp852"],
      [855, "cp855"],
      [857, "cp857"],
      [858, "cp858"],
      [860, "cp860"],
      [861, "cp861"],
      [862, "cp862"],
      [863, "cp863"],
      [865, "cp865"],
      [866, "cp866"],
      [869, "cp869"],
    ] as const;

    for (const [codePage, expectedEncoding] of mappings) {
      queryWindowsRegistryValueMock.mockReturnValueOnce(String(codePage));
      vi.resetModules();
      const {
        resolveWindowsOemCodePage,
        resolveWindowsOemCodePageForEncoding,
        resolveWindowsOemEncoding,
      } = await import("./windows-encoding.js");

      expect(resolveWindowsOemEncoding(), `OEMCP ${codePage}`).toBe(expectedEncoding);
      expect(resolveWindowsOemCodePage()).toBe(codePage);
      expect(resolveWindowsOemCodePageForEncoding(expectedEncoding)).toBe(codePage);
    }
  });

  it("reads and caches the boot-time OEM code page from HKLM", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    queryWindowsRegistryValueMock.mockReturnValue("857");
    vi.resetModules();
    const {
      resolveWindowsOemCodePage,
      resolveWindowsOemCodePageForEncoding,
      resolveWindowsOemEncoding,
    } = await import("./windows-encoding.js");

    expect(resolveWindowsOemEncoding()).toBe("cp857");
    expect(resolveWindowsOemCodePage()).toBe(857);
    expect(resolveWindowsOemEncoding()).toBe("cp857");
    expect(resolveWindowsOemCodePageForEncoding("cp857")).toBe(857);
    expect(resolveWindowsOemCodePageForEncoding("bogus")).toBeNull();
    expect(queryWindowsRegistryValueMock).toHaveBeenCalledOnce();
    expect(queryWindowsRegistryValueMock).toHaveBeenCalledWith(
      "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage",
      "OEMCP",
    );
  });

  it("caches unsupported OEM code pages as unavailable", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    queryWindowsRegistryValueMock.mockReturnValue("864");
    vi.resetModules();
    const { resolveWindowsOemCodePage, resolveWindowsOemEncoding } =
      await import("./windows-encoding.js");

    expect(resolveWindowsOemEncoding()).toBeNull();
    expect(resolveWindowsOemCodePage()).toBe(864);
    expect(resolveWindowsOemEncoding()).toBeNull();
    expect(queryWindowsRegistryValueMock).toHaveBeenCalledOnce();
  });

  it("does not query the Windows registry on other platforms", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.resetModules();
    const { resolveWindowsOemCodePage, resolveWindowsOemEncoding } =
      await import("./windows-encoding.js");

    expect(resolveWindowsOemEncoding()).toBeNull();
    expect(resolveWindowsOemCodePage()).toBeNull();
    expect(queryWindowsRegistryValueMock).not.toHaveBeenCalled();
  });

  it("bounds and caches failed Windows encoding probes", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    spawnSyncMock.mockReturnValue({
      error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }),
      output: [null, "", ""],
      pid: 1,
      signal: "SIGKILL",
      status: null,
      stderr: "",
      stdout: "",
    });
    vi.resetModules();
    const {
      decodeWindowsOutputBuffer: decodeOutputWithFreshCache,
      decodeWindowsTextFileBuffer: decodeTextWithFreshCache,
    } = await import("./windows-encoding.js");
    const undecodableByte = Buffer.from([0x80]);

    expect(decodeOutputWithFreshCache({ buffer: undecodableByte, platform: "win32" })).toBe(
      undecodableByte.toString("utf8"),
    );
    expect(decodeOutputWithFreshCache({ buffer: undecodableByte, platform: "win32" })).toBe(
      undecodableByte.toString("utf8"),
    );
    expect(decodeTextWithFreshCache({ buffer: undecodableByte, platform: "win32" })).toBe(
      undecodableByte.toString("utf8"),
    );
    expect(decodeTextWithFreshCache({ buffer: undecodableByte, platform: "win32" })).toBe(
      undecodableByte.toString("utf8"),
    );

    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      ["/d", "/s", "/c", "chcp"],
      {
        encoding: "utf8",
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5_000,
        windowsHide: true,
      },
    );
    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      2,
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Text.Encoding]::Default.CodePage"],
      {
        encoding: "utf8",
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5_000,
        windowsHide: true,
      },
    );
  });

  it("decodes GBK output on Windows when UTF-8 is invalid and code page is known", () => {
    const raw = Buffer.from([0xb2, 0xe2, 0xca, 0xd4, 0xa1, 0xab, 0xa3, 0xbb]);

    expect(
      decodeWindowsOutputBuffer({
        buffer: raw,
        platform: "win32",
        windowsEncoding: "gbk",
      }),
    ).toBe("测试～；");
  });

  it("prefers valid UTF-8 output on Windows even when the console code page is legacy", () => {
    const raw = Buffer.from("测试", "utf8");

    expect(
      decodeWindowsOutputBuffer({
        buffer: raw,
        platform: "win32",
        windowsEncoding: "gbk",
      }),
    ).toBe("测试");
  });

  it("falls back the whole output buffer when UTF-8 is truncated", () => {
    const raw = Buffer.from([0xc3, 0xa9, 0xc3]);

    expect(
      decodeWindowsOutputBuffer({
        buffer: raw,
        platform: "win32",
        windowsEncoding: "windows-1252",
      }),
    ).toBe("Ã©Ã");
  });

  it("decodes legacy text files with the Windows system encoding", () => {
    const raw = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);

    expect(
      decodeWindowsTextFileBuffer({
        buffer: raw,
        platform: "win32",
        windowsEncoding: "gbk",
      }),
    ).toBe("你好");
  });

  it("supports common Windows system codepage decoder labels", () => {
    for (const encoding of [
      "windows-874",
      "windows-1250",
      "windows-1251",
      "windows-1252",
      "windows-1253",
      "windows-1254",
      "windows-1255",
      "windows-1256",
      "windows-1257",
      "windows-1258",
    ]) {
      expect(() => new TextDecoder(encoding)).not.toThrow();
    }
  });

  it("keeps multibyte Windows codepage characters intact across chunk boundaries", () => {
    const decoder = createWindowsOutputDecoder({
      platform: "win32",
      windowsEncoding: "gbk",
    });

    expect(decoder.decode(Buffer.from([0xb2]))).toBe("");
    expect(decoder.decode(Buffer.from([0xe2, 0xca]))).toBe("测");
    expect(decoder.decode(Buffer.from([0xd4]))).toBe("试");
    expect(decoder.flush()).toBe("");
  });

  it("replays buffered UTF-8 lead bytes when split GBK output falls back to the console code page", () => {
    const decoder = createWindowsOutputDecoder({
      platform: "win32",
      windowsEncoding: "gbk",
    });

    expect(decoder.decode(Buffer.from([0xc4]))).toBe("");
    expect(decoder.decode(Buffer.from([0xe3]))).toBe("你");
    expect(decoder.flush()).toBe("");
  });

  it("keeps split valid UTF-8 output on the UTF-8 path for streaming decode", () => {
    const decoder = createWindowsOutputDecoder({
      platform: "win32",
      windowsEncoding: "gbk",
    });
    const raw = Buffer.from("测试", "utf8");

    expect(decoder.decode(raw.subarray(0, 1))).toBe("");
    expect(decoder.decode(raw.subarray(1, 3))).toBe("测");
    expect(decoder.decode(raw.subarray(3))).toBe("试");
    expect(decoder.flush()).toBe("");
  });

  it.each(["utf-8", "gbk"] as const)(
    "decodes complete UTF-16 BOM output with a %s console encoding",
    (windowsEncoding) => {
      for (const [, raw] of UTF16_OUTPUT_CASES) {
        const decoder = createWindowsOutputDecoder({ platform: "win32", windowsEncoding });
        expect(decoder.decode(raw) + decoder.flush()).toBe("hi\n");
      }
    },
  );

  it.each(["utf-8", "gbk"] as const)(
    "decodes complete UTF-16 BOM output buffers with a %s console encoding",
    (windowsEncoding) => {
      for (const [, raw] of UTF16_OUTPUT_CASES) {
        expect(decodeWindowsOutputBuffer({ buffer: raw, platform: "win32", windowsEncoding })).toBe(
          "hi\n",
        );
      }
    },
  );

  it.each(UTF16_OUTPUT_CASES)("decodes %s output across every chunk boundary", (_, raw) => {
    for (let split = 1; split < raw.length; split += 1) {
      const decoder = createWindowsOutputDecoder({
        platform: "win32",
        windowsEncoding: "gbk",
      });
      expect(
        decoder.decode(raw.subarray(0, split)) +
          decoder.decode(raw.subarray(split)) +
          decoder.flush(),
        `split ${split}`,
      ).toBe("hi\n");
    }
  });

  it("keeps empty-prefix and stdout/stderr decoder state isolated", () => {
    const stdout = createWindowsOutputDecoder({ platform: "win32", windowsEncoding: "gbk" });
    const stderr = createWindowsOutputDecoder({ platform: "win32", windowsEncoding: "gbk" });
    const stdoutRaw = UTF16_OUTPUT_CASES[0][1];
    const stderrRaw = UTF16_OUTPUT_CASES[1][1];

    expect(stdout.decode(Buffer.alloc(0))).toBe("");
    expect(stderr.decode(Buffer.alloc(0))).toBe("");
    expect(stdout.decode(stdoutRaw.subarray(0, 1))).toBe("");
    expect(stderr.decode(stderrRaw.subarray(0, 1))).toBe("");
    expect(stdout.decode(Buffer.alloc(0))).toBe("");
    expect(stderr.decode(Buffer.alloc(0))).toBe("");
    expect(stdout.decode(stdoutRaw.subarray(1)) + stdout.flush()).toBe("hi\n");
    expect(stderr.decode(stderrRaw.subarray(1)) + stderr.flush()).toBe("hi\n");
  });

  it.each(["utf-8", "gbk"] as const)(
    "replays unmatched and lone UTF-16 BOM prefixes through the %s path",
    (windowsEncoding) => {
      for (const raw of [Buffer.from([0xff, 0x41]), Buffer.from([0xfe, 0x42])]) {
        const decoder = createWindowsOutputDecoder({ platform: "win32", windowsEncoding });
        expect(decoder.decode(raw.subarray(0, 1))).toBe("");
        expect(decoder.decode(raw.subarray(1)) + decoder.flush()).toBe(
          new TextDecoder(windowsEncoding).decode(raw),
        );
      }

      const lonePrefix = Buffer.from([0xff]);
      const decoder = createWindowsOutputDecoder({ platform: "win32", windowsEncoding });
      expect(decoder.decode(lonePrefix)).toBe("");
      expect(decoder.flush()).toBe(new TextDecoder(windowsEncoding).decode(lonePrefix));
    },
  );

  it("strips a leading UTF-8 BOM by default", () => {
    for (const params of [
      { platform: "linux" },
      { platform: "win32", windowsEncoding: "utf-8" },
    ] as const) {
      const decoder = createWindowsOutputDecoder(params);
      expect(decoder.decode(Buffer.from("\uFEFFhello", "utf8")) + decoder.flush()).toBe("hello");
    }
  });

  it("preserves a split UTF-8 BOM when requested on POSIX", () => {
    const decoder = createWindowsOutputDecoder({
      platform: "linux",
      preserveUtf8Bom: true,
    });
    const raw = Buffer.from("\uFEFFhello", "utf8");

    expect(decoder.decode(raw.subarray(0, 1))).toBe("");
    expect(decoder.decode(raw.subarray(1, 2))).toBe("");
    expect(decoder.decode(raw.subarray(2))).toBe("\uFEFFhello");
    expect(decoder.flush()).toBe("");
  });

  it("preserves a split UTF-8 BOM before the Windows codepage fallback", () => {
    const decoder = createWindowsOutputDecoder({
      platform: "win32",
      preserveUtf8Bom: true,
      windowsEncoding: "gbk",
    });
    const raw = Buffer.from("\uFEFF测试", "utf8");

    expect(decoder.decode(raw.subarray(0, 1))).toBe("");
    expect(decoder.decode(raw.subarray(1, 2))).toBe("");
    expect(decoder.decode(raw.subarray(2, 4))).toBe("\uFEFF");
    expect(decoder.decode(raw.subarray(4))).toBe("测试");
    expect(decoder.flush()).toBe("");
  });

  it("keeps split UTF-8 output intact on POSIX", () => {
    const decoder = createWindowsOutputDecoder({ platform: "linux" });
    const raw = Buffer.from(JSON.stringify({ text: "hello 世" }), "utf8");
    const splitIndex = raw.indexOf(
      expectDefined(Buffer.from("世", "utf8")[0], 'Buffer.from("世", "utf8")[0] test invariant'),
    );

    expect(decoder.decode(raw.subarray(0, splitIndex + 1))).toBe(
      raw.subarray(0, splitIndex).toString("utf8"),
    );
    expect(decoder.decode(raw.subarray(splitIndex + 1))).toBe('世"}');
    expect(decoder.flush()).toBe("");
  });
});
