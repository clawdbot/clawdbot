import { describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { decodeCapturedOutputBuffer, parseWindowsCodePage, sanitizeEnv } from "./invoke.js";
import { buildNodeInvokeResultParams } from "./runner.js";

describe("node-host sanitizeEnv", () => {
  it("ignores PATH overrides", () => {
    withEnv({ PATH: "/usr/bin" }, () => {
      const env = sanitizeEnv({ PATH: "/tmp/evil:/usr/bin" });
      expect(env.PATH).toBe("/usr/bin");
    });
  });

  it("blocks dangerous env keys/prefixes", () => {
    withEnv(
      { PYTHONPATH: undefined, LD_PRELOAD: undefined, BASH_ENV: undefined, SHELLOPTS: undefined },
      () => {
        const env = sanitizeEnv({
          PYTHONPATH: "/tmp/pwn",
          LD_PRELOAD: "/tmp/pwn.so",
          BASH_ENV: "/tmp/pwn.sh",
          SHELLOPTS: "xtrace",
          PS4: "$(touch /tmp/pwned)",
          FOO: "bar",
        });
        expect(env.FOO).toBe("bar");
        expect(env.PYTHONPATH).toBeUndefined();
        expect(env.LD_PRELOAD).toBeUndefined();
        expect(env.BASH_ENV).toBeUndefined();
        expect(env.SHELLOPTS).toBeUndefined();
        expect(env.PS4).toBeUndefined();
      },
    );
  });

  it("blocks dangerous override-only env keys", () => {
    withEnv({ HOME: "/Users/trusted", ZDOTDIR: "/Users/trusted/.zdot" }, () => {
      const env = sanitizeEnv({
        HOME: "/tmp/evil-home",
        ZDOTDIR: "/tmp/evil-zdotdir",
      });
      expect(env.HOME).toBe("/Users/trusted");
      expect(env.ZDOTDIR).toBe("/Users/trusted/.zdot");
    });
  });

  it("drops dangerous inherited env keys even without overrides", () => {
    withEnv({ PATH: "/usr/bin:/bin", BASH_ENV: "/tmp/pwn.sh" }, () => {
      const env = sanitizeEnv(undefined);
      expect(env.PATH).toBe("/usr/bin:/bin");
      expect(env.BASH_ENV).toBeUndefined();
    });
  });

  it("preserves inherited non-portable Windows-style env keys", () => {
    withEnv({ "ProgramFiles(x86)": "C:\\Program Files (x86)" }, () => {
      const env = sanitizeEnv(undefined);
      expect(env["ProgramFiles(x86)"]).toBe("C:\\Program Files (x86)");
    });
  });
});

describe("node-host output decoding", () => {
  it("parses code pages from chcp output text", () => {
    expect(parseWindowsCodePage("Active code page: 936")).toBe(936);
    expect(parseWindowsCodePage("活动代码页: 65001")).toBe(65001);
    expect(parseWindowsCodePage("no code page")).toBeNull();
  });

  it("decodes GBK output on Windows when code page is known", () => {
    let supportsGbk = true;
    try {
      void new TextDecoder("gbk");
    } catch {
      supportsGbk = false;
    }

    const raw = Buffer.from([0xb2, 0xe2, 0xca, 0xd4, 0xa1, 0xab, 0xa3, 0xbb]);
    const decoded = decodeCapturedOutputBuffer({
      buffer: raw,
      platform: "win32",
      windowsEncoding: "gbk",
    });

    if (!supportsGbk) {
      expect(decoded).toContain("�");
      return;
    }
    expect(decoded).toBe("测试～；");
  });
});

describe("buildNodeInvokeResultParams", () => {
  it("omits optional fields when null/undefined", () => {
    const params = buildNodeInvokeResultParams(
      { id: "invoke-1", nodeId: "node-1", command: "system.run" },
      { ok: true, payloadJSON: null, error: null },
    );

    expect(params).toEqual({ id: "invoke-1", nodeId: "node-1", ok: true });
    expect("payloadJSON" in params).toBe(false);
    expect("error" in params).toBe(false);
  });

  it("includes payloadJSON when provided", () => {
    const params = buildNodeInvokeResultParams(
      { id: "invoke-2", nodeId: "node-2", command: "system.run" },
      { ok: true, payloadJSON: '{"ok":true}' },
    );

    expect(params.payloadJSON).toBe('{"ok":true}');
  });

  it("includes payload when provided", () => {
    const params = buildNodeInvokeResultParams(
      { id: "invoke-3", nodeId: "node-3", command: "system.run" },
      { ok: false, payload: { reason: "bad" } },
    );

    expect(params.payload).toEqual({ reason: "bad" });
  });
});
