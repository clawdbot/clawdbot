// Dev Tooling Safety tests cover dev tooling safety script behavior.
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testing as promptProbeTesting } from "../../scripts/anthropic-prompt-probe.ts";
import { testing as claudeUsageTesting } from "../../scripts/debug-claude-usage.ts";
import { testing as discordSmokeTesting } from "../../scripts/dev/discord-acp-plain-language-smoke.ts";
import { testing as realtimeSmokeTesting } from "../../scripts/dev/realtime-talk-live-smoke.ts";
import { testing as tuiPtyWatchTesting } from "../../scripts/dev/tui-pty-test-watch.ts";
import {
  maskIdentifier,
  parseBooleanEnv,
  parseStrictIntegerOption,
  previewForDevToolLog,
  redactHomePath,
  redactJsonValueForDevToolLog,
} from "../../scripts/lib/dev-tooling-safety.ts";
import { resolveWindowsTaskkillPath } from "../../scripts/lib/windows-taskkill.mjs";

const tempDirs: string[] = [];

function expectedTaskkillPath(): string {
  return resolveWindowsTaskkillPath();
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error("timed out waiting for condition");
}

// writeFileSync is not atomic for concurrent readers: the pid file can exist
// before its payload is flushed, so wait for non-empty content or the parse
// races into NaN under parallel-suite load. Generous budget: probe children
// boot node + tsx before the descendant pid lands.
async function waitForPidFile(pidPath: string, timeoutMs = 15_000): Promise<number> {
  let content = "";
  await waitForCondition(() => {
    try {
      content = readFileSync(pidPath, "utf8").trim();
    } catch {
      return false;
    }
    return content.length > 0;
  }, timeoutMs);
  return Number.parseInt(content, 10);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function writeFakePromptCli(root: string, descendantPidPath: string): Promise<string> {
  const fakeCli = path.join(root, "fake-prompt-cli.mjs");
  const descendantScript = [
    "process.on('SIGINT', () => {});",
    "process.on('SIGTERM', () => {});",
    "setInterval(() => {}, 1000);",
  ].join("");
  await fs.writeFile(
    fakeCli,
    [
      "#!/usr/bin/env node",
      "import childProcess from 'node:child_process';",
      "import fs from 'node:fs';",
      "const descendant = childProcess.spawn(process.execPath, [",
      "  '--input-type=module',",
      `  '--eval', ${JSON.stringify(descendantScript)},`,
      "], { stdio: 'ignore' });",
      `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    { mode: 0o755 },
  );
  return fakeCli;
}

async function waitForChildExit(
  child: ReturnType<typeof spawn>,
  timeoutMs = 8_000,
): Promise<{ status: number | null; signal: NodeJS.Signals | null }> {
  return await Promise.race([
    new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (status, signal) => resolve({ status, signal }));
    }),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("timed out waiting for child exit")), timeoutMs);
    }),
  ]);
}

afterEach(async () => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { force: true, recursive: true });
  }
});

describe("dev tooling safety helpers", () => {
  it("redacts secrets before truncating script log previews", () => {
    const token = "sk-test1234567890abcdefghijklmnop"; // pragma: allowlist secret
    const preview = previewForDevToolLog(`prefix OPENAI_API_KEY=${token} suffix`, 80);

    expect(preview).not.toContain(token);
    expect(preview).toContain("OPENAI_API_KEY=");
  });

  it("recursively redacts JSON-ish detail values before printing smoke results", () => {
    const token = "sk-test1234567890abcdefghijklmnop"; // pragma: allowlist secret
    const redacted = redactJsonValueForDevToolLog({
      nested: [{ message: `Authorization: Bearer ${token}` }],
    }) as { nested: Array<{ message: string }> };

    expect(redacted.nested[0]?.message).not.toContain(token);
    expect(redacted.nested[0]?.message).toContain("Authorization");
  });

  it("parses boolean env values explicitly", () => {
    expect(parseBooleanEnv({ fallback: false, name: "FLAG", raw: "yes" })).toBe(true);
    expect(parseBooleanEnv({ fallback: true, name: "FLAG", raw: "0" })).toBe(false);
    expect(() => parseBooleanEnv({ fallback: false, name: "FLAG", raw: "maybe" })).toThrow(
      /FLAG must be one of/u,
    );
  });

  it("rejects partial numeric option parses", () => {
    expect(parseStrictIntegerOption({ fallback: 3, label: "--runs", min: 1, raw: undefined })).toBe(
      3,
    );
    expect(() =>
      parseStrictIntegerOption({ fallback: 3, label: "--runs", min: 1, raw: "2abc" }),
    ).toThrow(/--runs must be an integer/u);
  });

  it("redacts home paths and masks opaque ids", () => {
    expect(redactHomePath("/home/alice/.openclaw/state.json", "/home/alice")).toBe(
      "~/.openclaw/state.json",
    );
    expect(maskIdentifier("session-key-abcdef123456")).toBe("sessio...3456");
  });
});

describe("script-specific dev tooling hardening", () => {
  it("rejects unknown Discord smoke drivers instead of silently using token mode", () => {
    expect(discordSmokeTesting.parseDriverMode("webhook")).toBe("webhook");
    expect(() => discordSmokeTesting.parseDriverMode("curl")).toThrow(/Invalid --driver/u);
  });

  it("rejects unknown Discord smoke args before live Discord/OpenClaw work", () => {
    expect(() => discordSmokeTesting.parseArgs(["--wat"])).toThrow("Unknown argument: --wat");

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/dev/discord-acp-plain-language-smoke.ts", "--wat"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Unknown argument: --wat");
  });

  it("prints Discord smoke usage without starting live validation", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/dev/discord-acp-plain-language-smoke.ts", "--help"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: bun scripts/dev/discord-acp-plain-language-smoke.ts");
    expect(result.stderr).toBe("");
  });

  it("rejects missing Discord smoke option values before env fallbacks", () => {
    expect(() => discordSmokeTesting.parseArgs(["--channel"])).toThrow(
      "--channel requires a value",
    );
    expect(() => discordSmokeTesting.parseArgs(["--channel="])).toThrow(
      "--channel requires a value",
    );
    expect(() => discordSmokeTesting.parseArgs(["--channel", "--json"])).toThrow(
      "--channel requires a value",
    );
    for (const flag of ["--channel", "--token", "--timeout-ms", "--state-dir"]) {
      expect(() => discordSmokeTesting.parseArgs([flag, "-h"])).toThrow(`${flag} requires a value`);
    }
  });

  it("redacts Discord webhook tokens from API paths", () => {
    const token = "webhook-secret-token-abcdef123456"; // pragma: allowlist secret
    const apiPath = `/webhooks/123/${token}?wait=true`;

    expect(discordSmokeTesting.redactDiscordApiPath(apiPath)).not.toContain(token);
    expect(discordSmokeTesting.redactDiscordApiPath(apiPath)).toContain("/webhooks/123/");
  });

  it("computes the remaining Discord smoke timeout budget", () => {
    expect(discordSmokeTesting.remainingTimeoutMs(1_500, 1_000)).toBe(500);
    expect(() => discordSmokeTesting.remainingTimeoutMs(1_000, 1_000)).toThrow(
      /exceeded total timeout/u,
    );
  });

  it("aborts stalled Discord smoke fetches at the request timeout", async () => {
    let signal: AbortSignal | undefined;
    const request = discordSmokeTesting.requestDiscordJson({
      method: "GET",
      path: "/users/@me",
      headers: {},
      retries: 0,
      timeoutMs: 5,
      errorPrefix: "Discord API",
      fetchImpl: ((_url, init) => {
        signal = init?.signal ?? undefined;
        return new Promise(() => {});
      }) as typeof fetch,
    });

    await expect(request).rejects.toThrow(/Discord API GET \/users\/@me exceeded timeout/u);
    expect(signal?.aborted).toBe(true);
  });

  it("times out stalled Discord smoke response body reads", async () => {
    const response = new Response(
      new ReadableStream({
        start() {},
      }),
      { status: 200, statusText: "OK" },
    );
    const request = discordSmokeTesting.requestDiscordJson({
      method: "GET",
      path: "/channels/123/messages",
      headers: {},
      retries: 0,
      timeoutMs: 5,
      errorPrefix: "Discord API",
      fetchImpl: (() => Promise.resolve(response)) as typeof fetch,
    });

    await expect(request).rejects.toThrow(
      /Discord API GET \/channels\/123\/messages exceeded timeout/u,
    );
  });

  it("bounds Discord smoke response bodies by content-length", async () => {
    const response = new Response("{}", {
      headers: { "content-length": "6" },
    });
    const request = discordSmokeTesting.requestDiscordJson({
      method: "GET",
      path: "/channels/123/messages",
      headers: {},
      retries: 0,
      timeoutMs: 50,
      responseBodyMaxBytes: 5,
      errorPrefix: "Discord API",
      fetchImpl: (() => Promise.resolve(response)) as typeof fetch,
    });

    await expect(request).rejects.toThrow(
      "Discord API GET /channels/123/messages response body exceeded 5 bytes",
    );
  });

  it("bounds Discord smoke response bodies by streamed bytes", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(6));
          controller.close();
        },
      }),
    );
    const request = discordSmokeTesting.requestDiscordJson({
      method: "GET",
      path: "/channels/123/messages",
      headers: {},
      retries: 0,
      timeoutMs: 50,
      responseBodyMaxBytes: 5,
      errorPrefix: "Discord API",
      fetchImpl: (() => Promise.resolve(response)) as typeof fetch,
    });

    await expect(request).rejects.toThrow(
      "Discord API GET /channels/123/messages response body exceeded 5 bytes",
    );
  });

  it("does not launch another Discord smoke retry after the timeout budget expires", async () => {
    let calls = 0;
    const response = {
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      json: async () => ({ retry_after: 1 }),
    } as Response;

    await expect(
      discordSmokeTesting.requestDiscordJson({
        method: "GET",
        path: "/channels/123/messages",
        headers: {},
        retries: 1,
        timeoutMs: 5,
        errorPrefix: "Discord API",
        fetchImpl: (() => {
          calls += 1;
          return Promise.resolve(response);
        }) as typeof fetch,
      }),
    ).rejects.toThrow(/exceeded total timeout/u);
    expect(calls).toBe(1);
  });

  it("prints TUI PTY watch usage without launching the watcher", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/dev/tui-pty-test-watch.ts", "--help"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: node --import tsx scripts/dev/tui-pty-test-watch.ts");
    expect(result.stderr).toBe("");
  });

  it("rejects unknown TUI PTY watch args before launching the watcher", () => {
    expect(() => tuiPtyWatchTesting.parseOptions(["--wat"])).toThrow("Unknown argument: --wat");

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/dev/tui-pty-test-watch.ts", "--wat"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("Unknown argument: --wat");
    expect(result.stdout).toBe("");
  });

  it("rejects short flags as TUI PTY watch option values", () => {
    for (const flag of ["--mode", "--mirror-path"]) {
      expect(() => tuiPtyWatchTesting.parseOptions([flag, "-h"])).toThrow(
        `${flag} requires a value`,
      );
    }
  });

  it("keeps TUI PTY watch vitest args behind the separator", () => {
    expect(tuiPtyWatchTesting.parseOptions(["--mode", "all", "--", "--help"])).toMatchObject({
      mode: "all",
      vitestArgs: ["--help"],
    });
  });

  it("escalates stalled TUI PTY watch children after interrupt cleanup", async () => {
    vi.useFakeTimers();
    const signals: NodeJS.Signals[] = [];
    const stopper = tuiPtyWatchTesting.createChildStopper(
      { kill: () => true },
      {
        signalChild(_child, signal: NodeJS.Signals): void {
          signals.push(signal);
        },
        sigkillGraceMs: 20,
        sigtermGraceMs: 10,
      },
    );

    stopper.stop();
    expect(signals).toEqual(["SIGINT"]);

    await vi.advanceTimersByTimeAsync(10);
    expect(signals).toEqual(["SIGINT", "SIGTERM"]);

    await vi.advanceTimersByTimeAsync(20);
    expect(signals).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
  });

  it("reads TUI PTY mirror updates incrementally with a bounded chunk", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tui-watch-test-"));
    tempDirs.push(tempRoot);
    const mirrorPath = path.join(tempRoot, "mirror.ansi");
    await fs.writeFile(mirrorPath, "first-second-third", "utf8");

    const first = await tuiPtyWatchTesting.readNewMirrorData(mirrorPath, 0, 6);
    expect(first.chunk.toString("utf8")).toBe("first-");
    expect(first.offset).toBe(6);

    const second = await tuiPtyWatchTesting.readNewMirrorData(mirrorPath, first.offset, 6);
    expect(second.chunk.toString("utf8")).toBe("second");
    expect(second.offset).toBe(12);
  });

  it("restarts TUI PTY mirror reads when the mirror file is truncated", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tui-watch-test-"));
    tempDirs.push(tempRoot);
    const mirrorPath = path.join(tempRoot, "mirror.ansi");
    await fs.writeFile(mirrorPath, "fresh", "utf8");

    const result = await tuiPtyWatchTesting.readNewMirrorData(mirrorPath, 10, 1024);

    expect(result.chunk.toString("utf8")).toBe("fresh");
    expect(result.offset).toBe(5);
  });

  it("drains all pending TUI PTY mirror chunks after the child exits", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tui-watch-test-"));
    tempDirs.push(tempRoot);
    const mirrorPath = path.join(tempRoot, "mirror.ansi");
    await fs.writeFile(mirrorPath, "first-second-third", "utf8");
    const chunks: string[] = [];

    const offset = await tuiPtyWatchTesting.drainNewMirrorData(
      mirrorPath,
      0,
      (chunk: Buffer) => chunks.push(chunk.toString("utf8")),
      6,
    );

    expect(chunks).toEqual(["first-", "second", "-third"]);
    expect(offset).toBe("first-second-third".length);
  });

  it("keeps only diagnostic tails from noisy TUI PTY child output", () => {
    const retained = tuiPtyWatchTesting.appendBufferTail(
      Buffer.from("0123456789", "utf8"),
      Buffer.from("abcdef", "utf8"),
      8,
    );

    expect(retained.toString("utf8")).toBe("89abcdef");
  });

  it.runIf(process.platform !== "win32")(
    "signals the TUI PTY watch process group before falling back to the child",
    () => {
      const kill = vi.spyOn(process, "kill").mockReturnValue(true);
      const childKill = vi.fn(() => true);

      try {
        tuiPtyWatchTesting.signalChildProcessTree({ pid: 123, kill: childKill }, "SIGTERM");
        expect(kill).toHaveBeenCalledWith(-123, "SIGTERM");
        expect(childKill).not.toHaveBeenCalled();
      } finally {
        kill.mockRestore();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "falls back to direct TUI PTY watch child signaling when the process group is gone",
    () => {
      const kill = vi.spyOn(process, "kill").mockImplementation(() => {
        const error = new Error("missing process group") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      });
      const childKill = vi.fn(() => true);

      try {
        tuiPtyWatchTesting.signalChildProcessTree({ pid: 123, kill: childKill }, "SIGTERM");
        expect(kill).toHaveBeenCalledWith(-123, "SIGTERM");
        expect(childKill).toHaveBeenCalledWith("SIGTERM");
      } finally {
        kill.mockRestore();
      }
    },
  );

  it("signals Windows TUI PTY watch process trees with taskkill", () => {
    const childKill = vi.fn(() => true);
    const runTaskkill = vi.fn(() => ({ error: undefined, status: 0 }));

    tuiPtyWatchTesting.signalChildProcessTree({ pid: 123, kill: childKill }, "SIGTERM", {
      platform: "win32",
      runTaskkill,
    });
    expect(runTaskkill).toHaveBeenNthCalledWith(1, expectedTaskkillPath(), ["/PID", "123", "/T"], {
      stdio: "ignore",
    });

    tuiPtyWatchTesting.signalChildProcessTree({ pid: 123, kill: childKill }, "SIGKILL", {
      platform: "win32",
      runTaskkill,
    });
    expect(runTaskkill).toHaveBeenNthCalledWith(
      2,
      expectedTaskkillPath(),
      ["/PID", "123", "/T", "/F"],
      {
        stdio: "ignore",
      },
    );
    expect(childKill).not.toHaveBeenCalled();
  });

  it("force-kills Windows TUI PTY watch process trees when graceful taskkill fails", () => {
    const childKill = vi.fn(() => true);
    const runTaskkill = vi
      .fn()
      .mockReturnValueOnce({ error: undefined, status: 1 })
      .mockReturnValueOnce({ error: undefined, status: 0 });

    tuiPtyWatchTesting.signalChildProcessTree({ pid: 123, kill: childKill }, "SIGTERM", {
      platform: "win32",
      runTaskkill,
    });

    expect(runTaskkill).toHaveBeenNthCalledWith(1, expectedTaskkillPath(), ["/PID", "123", "/T"], {
      stdio: "ignore",
    });
    expect(runTaskkill).toHaveBeenNthCalledWith(
      2,
      expectedTaskkillPath(),
      ["/PID", "123", "/T", "/F"],
      {
        stdio: "ignore",
      },
    );
    expect(childKill).not.toHaveBeenCalled();
  });

  it("aborts stalled OpenAI realtime smoke fetches at the request timeout", async () => {
    let signal: AbortSignal | undefined;
    const request = realtimeSmokeTesting.createOpenAIClientSecret("test-key", {
      timeoutMs: 5,
      fetchImpl: ((_url, init) => {
        signal = init?.signal ?? undefined;
        return new Promise(() => {});
      }) as typeof fetch,
    });

    await expect(request).rejects.toThrow(
      /OpenAI Realtime client secret request exceeded timeout/u,
    );
    expect(signal?.aborted).toBe(true);
  });

  it("times out stalled OpenAI realtime smoke response body reads", async () => {
    const response = new Response(
      new ReadableStream({
        start() {},
      }),
    );
    const request = realtimeSmokeTesting.createOpenAIClientSecret("test-key", {
      timeoutMs: 5,
      fetchImpl: (() => Promise.resolve(response)) as typeof fetch,
    });

    await expect(request).rejects.toThrow(
      /OpenAI Realtime client secret request exceeded timeout/u,
    );
  });

  it("rejects invalid OpenAI realtime smoke timeout values", () => {
    expect(realtimeSmokeTesting.resolveOpenAIHttpTimeoutMs("42")).toBe(42);
    expect(() => realtimeSmokeTesting.resolveOpenAIHttpTimeoutMs("2s")).toThrow(
      /OPENCLAW_REALTIME_OPENAI_HTTP_TIMEOUT_MS must be an integer/u,
    );
  });

  it("formats OpenAI realtime smoke help without launching live checks", () => {
    expect(realtimeSmokeTesting.parseRealtimeSmokeArgs(["--help"])).toEqual({
      help: true,
      openAIOnly: false,
    });
    expect(realtimeSmokeTesting.parseRealtimeSmokeArgs(["--openai-only"])).toEqual({
      help: false,
      openAIOnly: true,
    });
    expect(realtimeSmokeTesting.usage()).toContain(
      "Usage: node --import tsx scripts/dev/realtime-talk-live-smoke.ts",
    );
    expect(realtimeSmokeTesting.usage()).toContain("--openai-only");
  });

  it("rejects unknown OpenAI realtime smoke args before runtime setup", () => {
    expect(() => realtimeSmokeTesting.parseRealtimeSmokeArgs(["--wat"])).toThrow(
      "Unknown argument: --wat",
    );
  });

  it("bounds OpenAI realtime smoke response body reads by content-length", async () => {
    const maxBytes = realtimeSmokeTesting.OPENAI_HTTP_RESPONSE_MAX_BYTES;
    const response = new Response("{}", {
      headers: { "content-length": String(maxBytes + 1) },
    });

    await expect(
      realtimeSmokeTesting.readBoundedText(response, "OpenAI Realtime test", maxBytes),
    ).rejects.toThrow(`OpenAI Realtime test response body exceeded ${maxBytes} bytes`);
  });

  it("rejects unsafe OpenAI realtime SDP answer content-length values before reading", async () => {
    const maxBytes = realtimeSmokeTesting.OPENAI_HTTP_RESPONSE_MAX_BYTES;
    const body = {
      cancel: vi.fn(() => Promise.resolve()),
      getReader: vi.fn(() => {
        throw new Error("reader should not be acquired");
      }),
    };
    const response = {
      headers: new Headers({ "content-length": "9007199254740993" }),
      body,
    } as unknown as Response;

    await expect(
      realtimeSmokeTesting.readOpenAIRealtimeBrowserResponseText(
        response,
        "OpenAI Realtime SDP answer",
        maxBytes,
      ),
    ).rejects.toThrow(`OpenAI Realtime SDP answer response body exceeded ${maxBytes} bytes`);
    expect(body.getReader).not.toHaveBeenCalled();
    expect(body.cancel).toHaveBeenCalledTimes(1);
  });

  it("bounds OpenAI realtime smoke response body reads by streamed bytes", async () => {
    const maxBytes = realtimeSmokeTesting.OPENAI_HTTP_RESPONSE_MAX_BYTES;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(maxBytes + 1));
          controller.close();
        },
      }),
    );

    await expect(
      realtimeSmokeTesting.readBoundedText(response, "OpenAI Realtime test", maxBytes),
    ).rejects.toThrow(`OpenAI Realtime test response body exceeded ${maxBytes} bytes`);
  });

  it("rejects absolute-form URLs in the Anthropic capture proxy", () => {
    expect(
      promptProbeTesting.resolveAnthropicUpstreamUrl(
        "/v1/messages?anthropic-version=2023-06-01",
        "https://api.anthropic.com",
      ),
    ).toBe("https://api.anthropic.com/v1/messages?anthropic-version=2023-06-01");
    expect(() =>
      promptProbeTesting.resolveAnthropicUpstreamUrl(
        "http://169.254.169.254/latest/meta-data",
        "https://api.anthropic.com",
      ),
    ).toThrow(/refusing non-origin proxy request URL/u);
  });

  it("bounds Anthropic capture proxy request bodies", async () => {
    const request = Readable.from([Buffer.alloc(8), Buffer.alloc(8)]) as never;
    const destroy = vi.spyOn(request, "destroy");

    await expect(promptProbeTesting.readRequestBody(request, 12)).rejects.toThrow(
      "Anthropic capture proxy request body exceeded 12 bytes",
    );
    expect(destroy).toHaveBeenCalled();
  });

  it("reads only the bounded Anthropic prompt probe gateway log tail", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-prompt-probe-log-"));
    tempDirs.push(tempRoot);
    const logPath = path.join(tempRoot, "gateway.log");
    const token = "sk-test1234567890abcdefghijklmnop"; // pragma: allowlist secret
    await fs.writeFile(
      logPath,
      [
        `DO_NOT_PRINT_OLD_GATEWAY_LOG OPENAI_API_KEY=${token}`,
        "x".repeat(256),
        `recent gateway tail Authorization: Bearer ${token}`,
      ].join("\n"),
      "utf8",
    );

    const tail = await promptProbeTesting.readLogTail(logPath, 128);

    expect(tail).toContain("recent gateway tail");
    expect(tail).not.toContain("DO_NOT_PRINT_OLD_GATEWAY_LOG");
    expect(tail).not.toContain(token);
  });

  it("drops partial Anthropic prompt probe log lines before redaction", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-prompt-probe-log-"));
    tempDirs.push(tempRoot);
    const logPath = path.join(tempRoot, "gateway.log");
    const token = `sk-test${"a".repeat(80)}`; // pragma: allowlist secret
    await fs.writeFile(logPath, `Authorization: Bearer ${token}\nrecent gateway tail`, "utf8");

    const tail = await promptProbeTesting.readLogTail(logPath, "recent gateway tail".length + 24);

    expect(tail).toBe("recent gateway tail");
    expect(tail).not.toContain(token.slice(-16));
  });

  it("cleans Anthropic prompt probe temp dirs unless explicitly kept", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-prompt-probe-test-"));
    const keepRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-prompt-probe-test-"));

    expect(promptProbeTesting.promptProbeTmpResult(tempRoot, false)).toEqual({});
    expect(promptProbeTesting.promptProbeTmpResult(keepRoot, true)).toEqual({ tmpDir: keepRoot });

    await promptProbeTesting.cleanupPromptProbeTmpDir(tempRoot, false);
    await promptProbeTesting.cleanupPromptProbeTmpDir(keepRoot, true);

    await expect(fs.stat(tempRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(keepRoot)).resolves.toBeTruthy();
    await fs.rm(keepRoot, { force: true, recursive: true });
  });

  it.runIf(process.platform !== "win32")(
    "cleans Anthropic direct prompt descendants after timeout",
    async () => {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-direct-prompt-tree-"));
      tempDirs.push(tempRoot);
      const descendantPidPath = path.join(tempRoot, "descendant.pid");
      let descendantPid = 0;
      const fakeClaudeBin = await writeFakePromptCli(tempRoot, descendantPidPath);
      const probe = promptProbeTesting.runDirectPrompt("timeout cleanup proof", {
        claudeBin: fakeClaudeBin,
        timeoutMs: 500,
      });

      try {
        descendantPid = await waitForPidFile(descendantPidPath);
        expect(Number.isInteger(descendantPid)).toBe(true);
        expect(isProcessAlive(descendantPid)).toBe(true);

        await expect(probe).resolves.toMatchObject({
          exitCode: null,
          ok: false,
          signal: "SIGKILL",
        });
        await waitForCondition(() => !isProcessAlive(descendantPid));
      } finally {
        if (descendantPid && isProcessAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "cleans Anthropic direct prompt descendants on parent signal",
    async () => {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-direct-parent-signal-"));
      tempDirs.push(tempRoot);
      const descendantPidPath = path.join(tempRoot, "descendant.pid");
      let descendantPid = 0;
      const fakeClaudeBin = await writeFakePromptCli(tempRoot, descendantPidPath);
      const probe = spawn(
        process.execPath,
        ["--import", "tsx", "scripts/anthropic-prompt-probe.ts"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            CLAUDE_BIN: fakeClaudeBin,
            OPENCLAW_PROMPT_TEXT: "parent signal cleanup proof",
            OPENCLAW_PROMPT_TIMEOUT_MS: "10000",
            OPENCLAW_PROMPT_TRANSPORT: "direct",
          },
          stdio: "ignore",
        },
      );

      try {
        descendantPid = await waitForPidFile(descendantPidPath);
        expect(Number.isInteger(descendantPid)).toBe(true);
        expect(isProcessAlive(descendantPid)).toBe(true);

        const probeExit = waitForChildExit(probe);
        process.kill(probe.pid!, "SIGTERM");
        await expect(probeExit).resolves.toEqual({ status: 143, signal: null });
        await waitForCondition(() => !isProcessAlive(descendantPid));
      } finally {
        if (probe.pid && isProcessAlive(probe.pid)) {
          process.kill(probe.pid, "SIGKILL");
        }
        if (descendantPid && isProcessAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
      }
    },
  );

  it("waits for the Anthropic prompt gateway child after SIGKILL cleanup", async () => {
    const events = new EventEmitter();
    const signals: NodeJS.Signals[] = [];
    let closeCalls = 0;
    const child = {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill(signal: NodeJS.Signals) {
        signals.push(signal);
        if (signal === "SIGKILL") {
          setTimeout(() => {
            child.signalCode = "SIGKILL";
            events.emit("exit");
          }, 1);
        }
        return true;
      },
      once(event: "exit", listener: () => void) {
        events.once(event, listener);
      },
    };

    const stopped = await promptProbeTesting.stopGatewayPromptChild(
      child,
      {
        close: async () => {
          closeCalls += 1;
        },
      },
      1,
      50,
    );

    expect(stopped).toBe(true);
    expect(signals).toEqual(["SIGINT", "SIGKILL"]);
    expect(closeCalls).toBe(1);
  });

  it("bounds Anthropic prompt gateway cleanup when the child never exits", async () => {
    const signals: NodeJS.Signals[] = [];
    let closeCalls = 0;
    const child = {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill(signal: NodeJS.Signals) {
        signals.push(signal);
        return false;
      },
      once(_event: "exit", _listener: () => void) {},
    };

    const stopped = await promptProbeTesting.stopGatewayPromptChild(
      child,
      {
        close: async () => {
          closeCalls += 1;
        },
      },
      1,
      1,
    );

    expect(stopped).toBe(false);
    expect(signals).toEqual(["SIGINT", "SIGKILL"]);
    expect(closeCalls).toBe(1);
  });

  it.runIf(process.platform !== "win32")(
    "cleans Anthropic prompt gateway descendants after leader exit",
    async () => {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-prompt-gateway-tree-"));
      tempDirs.push(tempRoot);
      const descendantPidPath = path.join(tempRoot, "descendant.pid");
      let descendantPid = 0;
      const descendantScript = [
        "process.on('SIGINT', () => {});",
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1000);",
      ].join("");
      const leaderScript = [
        "import childProcess from 'node:child_process';",
        "import fs from 'node:fs';",
        "const descendant = childProcess.spawn(process.execPath, [",
        "  '--input-type=module',",
        `  '--eval', ${JSON.stringify(descendantScript)},`,
        "], { stdio: 'ignore' });",
        `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
        "process.on('SIGINT', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const child = spawn(process.execPath, ["--input-type=module", "--eval", leaderScript], {
        detached: true,
        stdio: "ignore",
      });
      let closeCalls = 0;

      try {
        await waitForCondition(() => isProcessAlive(child.pid!));
        descendantPid = await waitForPidFile(descendantPidPath);
        expect(Number.isInteger(descendantPid)).toBe(true);
        expect(isProcessAlive(descendantPid)).toBe(true);

        const stopped = await promptProbeTesting.stopGatewayPromptChild(
          child as Parameters<typeof promptProbeTesting.stopGatewayPromptChild>[0],
          {
            close: async () => {
              closeCalls += 1;
            },
          },
          50,
          100,
        );

        expect(stopped).toBe(true);
        expect(closeCalls).toBe(1);
        await waitForCondition(() => !isProcessAlive(descendantPid));
      } finally {
        if (child.pid && isProcessAlive(child.pid)) {
          process.kill(-child.pid, "SIGKILL");
        }
        if (descendantPid && isProcessAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "cleans Anthropic prompt gateway descendants on parent signal",
    async () => {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-prompt-parent-signal-"));
      tempDirs.push(tempRoot);
      const descendantPidPath = path.join(tempRoot, "descendant.pid");
      const readyPath = path.join(tempRoot, "ready");
      const runnerPath = path.join(tempRoot, "parent-signal-runner.mjs");
      let descendantPid = 0;
      const descendantScript = [
        "process.on('SIGINT', () => {});",
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1000);",
      ].join("");
      const leaderScript = [
        "import childProcess from 'node:child_process';",
        "import fs from 'node:fs';",
        "const descendant = childProcess.spawn(process.execPath, [",
        "  '--input-type=module',",
        `  '--eval', ${JSON.stringify(descendantScript)},`,
        "], { stdio: 'ignore' });",
        `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
        "process.on('SIGINT', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      await fs.writeFile(
        runnerPath,
        [
          "import childProcess from 'node:child_process';",
          "import fs from 'node:fs';",
          `const { testing } = await import(${JSON.stringify(
            pathToFileURL(path.resolve("scripts/anthropic-prompt-probe.ts")).href,
          )});`,
          `const child = childProcess.spawn(process.execPath, ['--input-type=module', '--eval', ${JSON.stringify(leaderScript)}], { detached: true, stdio: 'ignore' });`,
          "let stopPromise;",
          "const stopGateway = () => {",
          "  stopPromise ??= testing.stopGatewayPromptChild(child, { close: async () => {} }, 50, 100);",
          "  return stopPromise;",
          "};",
          "testing.installGatewayPromptParentSignalHandlers(child, stopGateway);",
          `fs.writeFileSync(${JSON.stringify(readyPath)}, String(process.pid));`,
          "setInterval(() => {}, 1000);",
        ].join("\n"),
        "utf8",
      );
      const runner = spawn(process.execPath, ["--import", "tsx", runnerPath], {
        stdio: "ignore",
      });

      try {
        await waitForCondition(() => existsSync(readyPath));
        descendantPid = await waitForPidFile(descendantPidPath);
        expect(Number.isInteger(descendantPid)).toBe(true);
        expect(isProcessAlive(descendantPid)).toBe(true);

        const runnerExit = waitForChildExit(runner);
        process.kill(runner.pid!, "SIGTERM");
        await expect(runnerExit).resolves.toEqual({ status: 143, signal: null });
        await waitForCondition(() => !isProcessAlive(descendantPid));
      } finally {
        if (runner.pid && isProcessAlive(runner.pid)) {
          process.kill(runner.pid, "SIGKILL");
        }
        if (descendantPid && isProcessAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
      }
    },
  );

  it("waits for Anthropic prompt gateway log writes before closing the log file", async () => {
    let resolveWrite: (() => void) | undefined;
    const order: string[] = [];
    const pendingWrite = new Promise<void>((resolve) => {
      resolveWrite = () => {
        order.push("write");
        resolve();
      };
    });
    const stop = promptProbeTesting.stopGatewayPromptChild(
      {
        exitCode: 0,
        signalCode: null,
        kill: () => true,
        once(_event: "exit", _listener: () => void) {},
      },
      {
        close: async () => {
          order.push("close");
        },
      },
      1,
      1,
      [pendingWrite],
    );

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(order).toEqual([]);

    resolveWrite?.();
    await expect(stop).resolves.toBe(true);
    expect(order).toEqual(["write", "close"]);
  });

  it("uses exact Claude cookie host matchers instead of broad substring matches", () => {
    expect(claudeUsageTesting.CLAUDE_COOKIE_HOST_SQL).toContain("host_key = 'claude.ai'");
    expect(claudeUsageTesting.CLAUDE_COOKIE_HOST_SQL).toContain("LIKE '%.claude.ai'");
    expect(claudeUsageTesting.CLAUDE_COOKIE_HOST_SQL).not.toContain("%claude.ai%");
  });

  it("rejects malformed Claude usage args before reading auth or browser state", () => {
    expect(claudeUsageTesting.parseArgs(["--agent", "work", "--session-key=abc"])).toEqual({
      agentId: "work",
      help: false,
      reveal: false,
      sessionKey: "abc",
    });
    expect(claudeUsageTesting.parseArgs(["--help"])).toEqual({
      agentId: "main",
      help: true,
      reveal: false,
      sessionKey: undefined,
    });
    expect(() => claudeUsageTesting.parseArgs(["--wat"])).toThrow("Unknown argument: --wat");
    expect(() => claudeUsageTesting.parseArgs(["--agent"])).toThrow("--agent requires a value");
    expect(() => claudeUsageTesting.parseArgs(["--agent="])).toThrow("--agent requires a value");
    expect(() => claudeUsageTesting.parseArgs(["--session-key", "--reveal"])).toThrow(
      "--session-key requires a value",
    );
    expect(() => claudeUsageTesting.parseArgs(["--session-key= "])).toThrow(
      "--session-key requires a value",
    );
  });

  it("prints Claude usage help without opening auth stores", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/debug-claude-usage.ts", "--help"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: node --import tsx scripts/debug-claude-usage.ts");
    expect(result.stderr).toBe("");
  });

  it("fails missing Claude usage option values before defaulting to main auth", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/debug-claude-usage.ts", "--agent"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--agent requires a value");
  });

  it("aborts stalled Claude usage fetches at the request timeout", async () => {
    let signal: AbortSignal | undefined;
    const request = claudeUsageTesting.fetchAnthropicOAuthUsage("test-token", {
      timeoutMs: 5,
      fetchImpl: ((_url, init) => {
        signal = init?.signal ?? undefined;
        return new Promise(() => {});
      }) as typeof fetch,
    });

    await expect(request).rejects.toThrow(/Anthropic OAuth usage request exceeded timeout/u);
    expect(signal?.aborted).toBe(true);
  });

  it("times out stalled Claude usage response body reads", async () => {
    const response = new Response(
      new ReadableStream({
        start() {},
      }),
      { headers: { "content-type": "application/json" } },
    );
    const request = claudeUsageTesting.fetchAnthropicOAuthUsage("test-token", {
      timeoutMs: 5,
      fetchImpl: (() => Promise.resolve(response)) as typeof fetch,
    });

    await expect(request).rejects.toThrow(/Anthropic OAuth usage request exceeded timeout/u);
  });

  it("rejects invalid Claude usage timeout values", () => {
    expect(claudeUsageTesting.resolveFetchTimeoutMs("123")).toBe(123);
    expect(() => claudeUsageTesting.resolveFetchTimeoutMs("1.5")).toThrow(
      /OPENCLAW_DEBUG_CLAUDE_USAGE_FETCH_TIMEOUT_MS must be an integer/u,
    );
  });

  it("bounds Claude usage response body reads by content-length", async () => {
    const maxBytes = claudeUsageTesting.FETCH_RESPONSE_MAX_BYTES;
    const response = new Response("{}", {
      headers: { "content-length": String(maxBytes + 1) },
    });
    const controller = new AbortController();

    await expect(
      claudeUsageTesting.readBoundedResponseText(
        response,
        "Claude usage test",
        controller.signal,
        maxBytes,
      ),
    ).rejects.toThrow(`Claude usage test response body exceeded ${maxBytes} bytes`);
  });

  it("bounds Claude usage response body reads by streamed bytes", async () => {
    const maxBytes = claudeUsageTesting.FETCH_RESPONSE_MAX_BYTES;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(maxBytes + 1));
          controller.close();
        },
      }),
    );
    const controller = new AbortController();

    await expect(
      claudeUsageTesting.readBoundedResponseText(
        response,
        "Claude usage test",
        controller.signal,
        maxBytes,
      ),
    ).rejects.toThrow(`Claude usage test response body exceeded ${maxBytes} bytes`);
  });
});
