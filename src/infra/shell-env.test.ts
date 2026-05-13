import fs from "node:fs";
import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  getShellEnvAppliedKeys,
  getShellPathFromLoginShell,
  loadShellEnvFallback,
  resetShellPathCacheForTests,
  resolveShellEnvFallbackTimeoutMs,
  shouldDeferShellEnvFallback,
  shouldEnableShellEnvFallback,
} from "./shell-env.js";

describe("shell env fallback", () => {
  function getShellPathTwice(params: {
    exec: Parameters<typeof getShellPathFromLoginShell>[0]["exec"];
    platform: NodeJS.Platform;
  }) {
    const first = getShellPathFromLoginShell({
      env: {} as NodeJS.ProcessEnv,
      exec: params.exec,
      platform: params.platform,
    });
    const second = getShellPathFromLoginShell({
      env: {} as NodeJS.ProcessEnv,
      exec: params.exec,
      platform: params.platform,
    });
    return { first, second };
  }

  function runShellEnvFallbackForShell(shell: string) {
    resetShellPathCacheForTests();
    const env: NodeJS.ProcessEnv = { SHELL: shell };
    const exec = vi.fn(() => Buffer.from("OPENAI_API_KEY=from-shell\0"));
    const res = runShellEnvFallback({
      enabled: true,
      env,
      expectedKeys: ["OPENAI_API_KEY"],
      exec,
    });
    return { res, exec };
  }

  function runShellEnvFallback(params: {
    enabled: boolean;
    env: NodeJS.ProcessEnv;
    expectedKeys: string[];
    exec: ReturnType<typeof vi.fn>;
  }) {
    return loadShellEnvFallback({
      enabled: params.enabled,
      env: params.env,
      expectedKeys: params.expectedKeys,
      exec: params.exec as unknown as Parameters<typeof loadShellEnvFallback>[0]["exec"],
    });
  }

  function makeUnsafeStartupEnv(): NodeJS.ProcessEnv {
    return {
      SHELL: "/bin/bash",
      HOME: "/tmp/evil-home",
      ZDOTDIR: "/tmp/evil-zdotdir",
      BASH_ENV: "/tmp/evil-bash-env",
      PS4: "$(touch /tmp/pwned)",
    };
  }

  function expectSanitizedStartupEnv(receivedEnv: NodeJS.ProcessEnv | undefined) {
    if (receivedEnv === undefined) {
      throw new Error("expected sanitized startup env");
    }
    expect(receivedEnv.BASH_ENV).toBeUndefined();
    expect(receivedEnv.PS4).toBeUndefined();
    expect(receivedEnv.ZDOTDIR).toBeUndefined();
    expect(receivedEnv.SHELL).toBeUndefined();
    expect(receivedEnv.HOME).toBe(os.homedir());
  }

  function withEtcShells(shells: string[], fn: () => void) {
    const etcShellsContent = `${shells.join("\n")}\n`;
    const readFileSyncSpy = vi
      .spyOn(fs, "readFileSync")
      .mockImplementation((filePath, encoding) => {
        if (filePath === "/etc/shells" && encoding === "utf8") {
          return etcShellsContent;
        }
        throw new Error(`Unexpected readFileSync(${String(filePath)}) in test`);
      });
    try {
      fn();
    } finally {
      readFileSyncSpy.mockRestore();
    }
  }

  function requireExecCall(exec: ReturnType<typeof vi.fn>): unknown[] {
    const call = exec.mock.calls[0];
    if (!call) {
      throw new Error("expected shell env exec call");
    }
    return call;
  }

  function getShellPathTwiceWithExec(params: {
    exec: ReturnType<typeof vi.fn>;
    platform: NodeJS.Platform;
  }) {
    return getShellPathTwice({
      exec: params.exec as unknown as Parameters<typeof getShellPathFromLoginShell>[0]["exec"],
      platform: params.platform,
    });
  }

  function probeShellPathWithFreshCache(params: {
    exec: ReturnType<typeof vi.fn>;
    platform: NodeJS.Platform;
  }) {
    resetShellPathCacheForTests();
    return getShellPathTwiceWithExec(params);
  }

  function expectBinShFallbackExec(exec: ReturnType<typeof vi.fn>) {
    expect(exec).toHaveBeenCalledTimes(1);
    const [shell, args, options] = requireExecCall(exec);
    expect(shell).toBe("/bin/sh");
    expect(args).toStrictEqual(["-l", "-c", "env -0"]);
    expect((options as { windowsHide?: unknown } | undefined)?.windowsHide).toBe(true);
  }

  it("is disabled by default", () => {
    expect(shouldEnableShellEnvFallback({} as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldEnableShellEnvFallback({ OPENCLAW_LOAD_SHELL_ENV: "0" })).toBe(false);
    expect(shouldEnableShellEnvFallback({ OPENCLAW_LOAD_SHELL_ENV: "1" })).toBe(true);
  });

  it("uses the same truthy env parsing for deferred fallback", () => {
    expect(shouldDeferShellEnvFallback({} as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldDeferShellEnvFallback({ OPENCLAW_DEFER_SHELL_ENV_FALLBACK: "false" })).toBe(false);
    expect(shouldDeferShellEnvFallback({ OPENCLAW_DEFER_SHELL_ENV_FALLBACK: "yes" })).toBe(true);
  });

  it("resolves timeout from env with default fallback", () => {
    expect(resolveShellEnvFallbackTimeoutMs({} as NodeJS.ProcessEnv)).toBe(15000);
    expect(resolveShellEnvFallbackTimeoutMs({ OPENCLAW_SHELL_ENV_TIMEOUT_MS: "42" })).toBe(42);
    expect(
      resolveShellEnvFallbackTimeoutMs({
        OPENCLAW_SHELL_ENV_TIMEOUT_MS: "nope",
      }),
    ).toBe(15000);
  });

  it("skips when already has all expected keys", () => {
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "set", DISCORD_BOT_TOKEN: "set" };
    const exec = vi.fn(() => Buffer.from(""));

    const res = runShellEnvFallback({
      enabled: true,
      env,
      expectedKeys: ["OPENAI_API_KEY", "DISCORD_BOT_TOKEN"],
      exec,
    });

    expect(res.ok).toBe(true);
    expect(res.applied).toStrictEqual([]);
    expect(res.ok && res.skippedReason).toBe("already-has-keys");
    expect(exec).not.toHaveBeenCalled();
  });

  it("imports missing expected keys even when another expected key already exists", () => {
    const env: NodeJS.ProcessEnv = { OPENCLAW_GATEWAY_TOKEN: "set" };
    const exec = vi.fn(() =>
      Buffer.from(
        "OPENCLAW_GATEWAY_TOKEN=from-shell\0TWILIO_ACCOUNT_SID=AC123\0TWILIO_AUTH_TOKEN=secret\0TWILIO_FROM_NUMBER=+15550001234\0",
      ),
    );

    const res = runShellEnvFallback({
      enabled: true,
      env,
      expectedKeys: [
        "OPENCLAW_GATEWAY_TOKEN",
        "TWILIO_ACCOUNT_SID",
        "TWILIO_AUTH_TOKEN",
        "TWILIO_FROM_NUMBER",
      ],
      exec,
    });

    expect(res).toEqual({
      ok: true,
      applied: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"],
    });
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBe("set");
    expect(env.TWILIO_ACCOUNT_SID).toBe("AC123");
    expect(env.TWILIO_AUTH_TOKEN).toBe("secret");
    expect(env.TWILIO_FROM_NUMBER).toBe("+15550001234");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("treats explicitly empty env vars as intentional overrides", () => {
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "" };
    const exec = vi.fn(() => Buffer.from("OPENAI_API_KEY=from-shell\0"));

    const res = runShellEnvFallback({
      enabled: true,
      env,
      expectedKeys: ["OPENAI_API_KEY"],
      exec,
    });

    expect(res.ok).toBe(true);
    expect(res.applied).toStrictEqual([]);
    expect(res.ok && res.skippedReason).toBe("already-has-keys");
    expect(env.OPENAI_API_KEY).toBe("");
    expect(exec).not.toHaveBeenCalled();
  });

  it("imports expected keys without overriding existing env", () => {
    const env: NodeJS.ProcessEnv = {};
    const exec = vi.fn(() => Buffer.from("OPENAI_API_KEY=from-shell\0DISCORD_BOT_TOKEN=discord\0"));

    const res1 = runShellEnvFallback({
      enabled: true,
      env,
      expectedKeys: ["OPENAI_API_KEY", "DISCORD_BOT_TOKEN"],
      exec,
    });

    expect(res1.ok).toBe(true);
    expect(env.OPENAI_API_KEY).toBe("from-shell");
    expect(env.DISCORD_BOT_TOKEN).toBe("discord");
    expect(exec).toHaveBeenCalledTimes(1);

    env.OPENAI_API_KEY = "from-parent";
    const exec2 = vi.fn(() =>
      Buffer.from("OPENAI_API_KEY=from-shell\0DISCORD_BOT_TOKEN=discord2\0"),
    );
    const res2 = runShellEnvFallback({
      enabled: true,
      env,
      expectedKeys: ["OPENAI_API_KEY", "DISCORD_BOT_TOKEN"],
      exec: exec2,
    });

    expect(res2.ok).toBe(true);
    expect(env.OPENAI_API_KEY).toBe("from-parent");
    expect(env.DISCORD_BOT_TOKEN).toBe("discord");
    expect(exec2).not.toHaveBeenCalled();
  });

  it("reuses the cached login-shell env probe across repeated fallback reads", () => {
    resetShellPathCacheForTests();
    const env: NodeJS.ProcessEnv = {};
    const exec = vi.fn(() =>
      Buffer.from("OPENAI_API_KEY=from-shell\0ANTHROPIC_API_KEY=from-shell-anthropic\0"),
    );

    expect(
      loadShellEnvFallback({
        enabled: true,
        env,
        expectedKeys: ["OPENAI_API_KEY"],
        exec: exec as unknown as Parameters<typeof loadShellEnvFallback>[0]["exec"],
      }),
    ).toEqual({
      ok: true,
      applied: ["OPENAI_API_KEY"],
    });

    expect(
      loadShellEnvFallback({
        enabled: true,
        env,
        expectedKeys: ["ANTHROPIC_API_KEY"],
        exec: exec as unknown as Parameters<typeof loadShellEnvFallback>[0]["exec"],
      }),
    ).toEqual({
      ok: true,
      applied: ["ANTHROPIC_API_KEY"],
    });

    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("caches login-shell env probe failures for repeated fallback reads", () => {
    resetShellPathCacheForTests();
    const env: NodeJS.ProcessEnv = {};
    const logger = { warn: vi.fn() };
    const exec = vi.fn(() => {
      throw new Error("shell unavailable");
    });

    for (let i = 0; i < 2; i += 1) {
      const result = loadShellEnvFallback({
        enabled: true,
        env,
        expectedKeys: ["OPENAI_API_KEY"],
        exec: exec as unknown as Parameters<typeof loadShellEnvFallback>[0]["exec"],
        logger,
      });
      expect(result).toEqual({
        ok: false,
        applied: [],
        error: "shell unavailable",
      });
    }

    expect(exec).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("tracks last applied keys across success, skip, and failure paths", () => {
    const successEnv: NodeJS.ProcessEnv = {};
    const successExec = vi.fn(() =>
      Buffer.from("OPENAI_API_KEY=from-shell\0DISCORD_BOT_TOKEN=\0EXTRA=ignored\0"),
    );
    expect(
      loadShellEnvFallback({
        enabled: true,
        env: successEnv,
        expectedKeys: ["OPENAI_API_KEY", "DISCORD_BOT_TOKEN"],
        exec: successExec as unknown as Parameters<typeof loadShellEnvFallback>[0]["exec"],
      }),
    ).toEqual({
      ok: true,
      applied: ["OPENAI_API_KEY"],
    });
    expect(getShellEnvAppliedKeys()).toEqual(["OPENAI_API_KEY"]);

    expect(
      loadShellEnvFallback({
        enabled: false,
        env: {},
        expectedKeys: ["OPENAI_API_KEY"],
        exec: successExec as unknown as Parameters<typeof loadShellEnvFallback>[0]["exec"],
      }),
    ).toEqual({
      ok: true,
      applied: [],
      skippedReason: "disabled",
    });
    expect(getShellEnvAppliedKeys()).toStrictEqual([]);

    const failureExec = vi.fn(() => {
      throw new Error("boom");
    });
    expect(
      loadShellEnvFallback({
        enabled: true,
        env: {},
        expectedKeys: ["OPENAI_API_KEY"],
        exec: failureExec as unknown as Parameters<typeof loadShellEnvFallback>[0]["exec"],
        logger: { warn: vi.fn() },
      }),
    ).toEqual({
      ok: false,
      applied: [],
      error: "boom",
    });
    expect(getShellEnvAppliedKeys()).toStrictEqual([]);
  });

  it("resolves PATH via login shell and caches it", () => {
    const exec = vi.fn(() => Buffer.from("PATH=/usr/local/bin:/usr/bin\0HOME=/tmp\0"));

    const { first, second } = probeShellPathWithFreshCache({
      exec,
      platform: "linux",
    });

    expect(first).toBe("/usr/local/bin:/usr/bin");
    expect(second).toBe("/usr/local/bin:/usr/bin");
    expect(exec).toHaveBeenCalledOnce();
  });

  it("returns null on shell env read failure and caches null", () => {
    const exec = vi.fn(() => {
      throw new Error("exec failed");
    });

    const { first, second } = probeShellPathWithFreshCache({
      exec,
      platform: "linux",
    });

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(exec).toHaveBeenCalledOnce();
  });

  it("returns null when login shell PATH is blank", () => {
    const exec = vi.fn(() => Buffer.from("PATH=   \0HOME=/tmp\0"));

    const { first, second } = probeShellPathWithFreshCache({
      exec,
      platform: "linux",
    });

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(exec).toHaveBeenCalledOnce();
  });

  it("falls back to /bin/sh when SHELL is non-absolute", () => {
    const { res, exec } = runShellEnvFallbackForShell("zsh");

    expect(res.ok).toBe(true);
    expectBinShFallbackExec(exec);
  });

  it("falls back to /bin/sh when SHELL points to an untrusted path", () => {
    const { res, exec } = runShellEnvFallbackForShell("/tmp/evil-shell");

    expect(res.ok).toBe(true);
    expectBinShFallbackExec(exec);
  });

  it("falls back to /bin/sh when SHELL is absolute but not registered in /etc/shells", () => {
    withEtcShells(["/bin/sh", "/bin/bash", "/bin/zsh"], () => {
      const { res, exec } = runShellEnvFallbackForShell("/opt/homebrew/bin/evil-shell");

      expect(res.ok).toBe(true);
      expectBinShFallbackExec(exec);
    });
  });

  it("uses SHELL when it is explicitly registered in /etc/shells", () => {
    const trustedShell =
      process.platform === "win32"
        ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
        : "/usr/bin/zsh-trusted";
    withEtcShells(["/bin/sh", trustedShell], () => {
      const { res, exec } = runShellEnvFallbackForShell(trustedShell);

      expect(res.ok).toBe(true);
      expect(exec).toHaveBeenCalledTimes(1);
      const [shell, args, options] = requireExecCall(exec);
      expect(shell).toBe(trustedShell);
      expect(args).toStrictEqual(["-l", "-c", "env -0"]);
      expect((options as { windowsHide?: unknown } | undefined)?.windowsHide).toBe(true);
    });
  });

  it("sanitizes startup-related env vars before shell fallback exec", () => {
    const env = makeUnsafeStartupEnv();
    let receivedEnv: NodeJS.ProcessEnv | undefined;
    const exec = vi.fn((_shell: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      receivedEnv = options.env;
      return Buffer.from("OPENAI_API_KEY=from-shell\0");
    });

    const res = runShellEnvFallback({
      enabled: true,
      env,
      expectedKeys: ["OPENAI_API_KEY"],
      exec,
    });

    expect(res.ok).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
    expectSanitizedStartupEnv(receivedEnv);
  });

  it("sanitizes startup-related env vars before login-shell PATH probe", () => {
    resetShellPathCacheForTests();
    const env = makeUnsafeStartupEnv();
    let receivedEnv: NodeJS.ProcessEnv | undefined;
    const exec = vi.fn((_shell: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      receivedEnv = options.env;
      return Buffer.from("PATH=/usr/local/bin:/usr/bin\0HOME=/tmp\0");
    });

    const result = getShellPathFromLoginShell({
      env,
      exec: exec as unknown as Parameters<typeof getShellPathFromLoginShell>[0]["exec"],
      platform: "linux",
    });

    expect(result).toBe("/usr/local/bin:/usr/bin");
    expect(exec).toHaveBeenCalledTimes(1);
    expectSanitizedStartupEnv(receivedEnv);
  });

  it("returns null without invoking shell on win32", () => {
    const exec = vi.fn(() => Buffer.from("PATH=/usr/local/bin:/usr/bin\0HOME=/tmp\0"));

    const { first, second } = probeShellPathWithFreshCache({
      exec,
      platform: "win32",
    });

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });
});
