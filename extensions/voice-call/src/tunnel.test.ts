// Voice Call tests cover tunnel plugin behavior.
import type { ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, type Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

type RealPipeChild = ChildProcessByStdio<null, Readable, Readable>;

class FakeChildProcess extends EventEmitter {
  // PassThrough honors setEncoding("utf8") like real child pipes, so split
  // multibyte writes exercise the same decoder path as production ngrok.
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killedWith: NodeJS.Signals | null = null;
  readonly killSignals: NodeJS.Signals[] = [];
  readonly ignoredSignals = new Set<NodeJS.Signals>();
  closeOnKill = true;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killedWith = signal;
    this.killSignals.push(signal);
    if (this.closeOnKill && !this.ignoredSignals.has(signal)) {
      queueMicrotask(() => this.emit("close", null));
    }
    return true;
  }

  close(code: number | null = 0): void {
    this.emit("close", code);
  }

  fail(error: Error): void {
    this.emit("error", error);
  }
}

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  realSpawn: undefined as undefined | typeof import("node:child_process").spawn,
  setupTailscaleExposureRoutes: vi.fn(),
  cleanupTailscaleExposureRoute: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  mocks.realSpawn = actual.spawn;
  return {
    ...actual,
    spawn: mocks.spawn,
  };
});

vi.mock("./webhook/tailscale.js", () => ({
  setupTailscaleExposureRoutes: mocks.setupTailscaleExposureRoutes,
  cleanupTailscaleExposureRoute: mocks.cleanupTailscaleExposureRoute,
}));

import { startTunnel } from "./tunnel.js";

async function requireTunnel(result: ReturnType<typeof startTunnel>) {
  const tunnel = await result;
  if (!tunnel) {
    throw new Error("Expected tunnel to start");
  }
  return tunnel;
}

function startNgrokTunnel(config: {
  port: number;
  path: string;
  authToken?: string;
  domain?: string;
}) {
  return requireTunnel(
    startTunnel({
      provider: "ngrok",
      port: config.port,
      path: config.path,
      ngrokAuthToken: config.authToken,
      ngrokDomain: config.domain,
    }),
  );
}

function startTailscaleTunnel(config: {
  mode: "serve" | "funnel";
  port: number;
  path: string;
  tailscalePort?: number;
  streamPaths?: Array<{ publicPath: string; localPath: string }>;
}) {
  return requireTunnel(
    startTunnel({
      provider: config.mode === "serve" ? "tailscale-serve" : "tailscale-funnel",
      port: config.port,
      path: config.path,
      tailscalePort: config.tailscalePort ?? 443,
      streamPaths: config.streamPaths,
    }),
  );
}

function nextProcess(): FakeChildProcess {
  const proc = new FakeChildProcess();
  mocks.spawn.mockReturnValueOnce(proc as never);
  return proc;
}

function emitNgrokUrl(proc: FakeChildProcess, url: string): void {
  proc.stdout.write(`${JSON.stringify({ msg: "started tunnel", url })}\n`);
}

function midEmojiSplit(text: string): { bytes: Buffer; splitAt: number } {
  const bytes = Buffer.from(text, "utf8");
  const splitAt = bytes.indexOf(Buffer.from("😀", "utf8")) + 2;
  expect(bytes[splitAt - 2]).toBe(0xf0);
  return { bytes, splitAt };
}

/** Real child pipes: production `setEncoding("utf8")` on OS-delivered chunk boundaries. */
function mockSpawnUtf8SplitChild(params: {
  stream: "stdout" | "stderr";
  text: string;
  splitAt: number;
  delayMs?: number;
}): void {
  const delayMs = params.delayMs ?? 40;
  const script = [
    `const bytes=Buffer.from(${JSON.stringify(params.text)},"utf8");`,
    `const split=${params.splitAt};`,
    `const stream=process.${params.stream};`,
    `stream.write(bytes.subarray(0,split));`,
    `setTimeout(()=>stream.write(bytes.subarray(split),()=>{}),${delayMs});`,
  ].join("");
  mocks.spawn.mockImplementationOnce(() => {
    const spawnReal = mocks.realSpawn;
    if (!spawnReal) {
      throw new Error("expected real child_process.spawn from importOriginal");
    }
    return spawnReal(process.execPath, ["-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    }) as RealPipeChild;
  });
}

describe("voice-call tunnels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setupTailscaleExposureRoutes.mockResolvedValue(
      "https://host.tailnet.ts.net/voice/webhook",
    );
    mocks.cleanupTailscaleExposureRoute.mockResolvedValue(undefined);
  });

  it("starts ngrok and appends the webhook path to the public URL", async () => {
    const proc = nextProcess();
    const result = startNgrokTunnel({ port: 3334, path: "/voice/webhook" });

    emitNgrokUrl(proc, "https://abc.ngrok.io");

    const tunnel = await result;
    expect(tunnel.publicUrl).toBe("https://abc.ngrok.io/voice/webhook");
    expect(tunnel.provider).toBe("ngrok");
    expect(tunnel.stop).toBeTypeOf("function");
    expect(mocks.spawn).toHaveBeenCalledWith(
      "ngrok",
      ["http", "3334", "--log", "stdout", "--log-format", "json"],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  });

  it("bounds ngrok stop even when forced termination never emits close", async () => {
    vi.useFakeTimers();
    try {
      const proc = nextProcess();
      proc.closeOnKill = false;
      const result = startNgrokTunnel({ port: 3334, path: "/voice/webhook" });
      emitNgrokUrl(proc, "https://stuck.ngrok.io");
      const tunnel = await result;

      const stop = tunnel.stop();
      await vi.advanceTimersByTimeAsync(3_000);

      await expect(stop).resolves.toBeUndefined();
      expect(proc.killedWith).toBe("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("unrefs the ngrok startup timeout", async () => {
    const unrefSpy = vi.fn();
    const setTimeoutOriginal = globalThis.setTimeout.bind(globalThis);
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((handler: TimerHandler, timeout?: number) => {
        const timer = Reflect.apply(setTimeoutOriginal, globalThis, [handler, timeout]);
        Object.defineProperty(timer, "unref", { value: unrefSpy, configurable: true });
        return timer;
      });
    try {
      const proc = nextProcess();
      const result = startNgrokTunnel({ port: 3334, path: "/voice/webhook" });
      emitNgrokUrl(proc, "https://unref.ngrok.io");

      await result;

      expect(unrefSpy).toHaveBeenCalledOnce();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("force-kills ngrok before rejecting a startup timeout", async () => {
    vi.useFakeTimers();
    try {
      const proc = nextProcess();
      proc.ignoredSignals.add("SIGTERM");
      const result = startNgrokTunnel({ port: 3334, path: "/voice/webhook" });
      const rejection = expect(result).rejects.toThrow("ngrok startup timed out (30s)");

      await vi.advanceTimersByTimeAsync(30_000);
      expect(proc.killSignals).toEqual(["SIGTERM"]);

      await vi.advanceTimersByTimeAsync(2_000);
      await rejection;
      expect(proc.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("parses complete ngrok log lines before bounding the incomplete tail", async () => {
    const proc = nextProcess();
    const result = startNgrokTunnel({ port: 3334, path: "/voice/webhook" });

    proc.stdout.write(
      `${JSON.stringify({ msg: "started tunnel", url: "https://large.ngrok.io" })}\n${"x".repeat(20_000)}`,
    );

    const settled = await Promise.race([
      result.then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 20);
      }),
    ]);
    expect(settled).toBe(true);

    const tunnel = await result;
    expect(tunnel.publicUrl).toBe("https://large.ngrok.io/voice/webhook");
  });

  it("keeps the ngrok auth token out of child argv", async () => {
    const tunnelProc = nextProcess();
    const result = startNgrokTunnel({
      port: 3334,
      path: "/hook",
      authToken: "token",
    });

    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1));
    emitNgrokUrl(tunnelProc, "https://auth.ngrok.io");

    const tunnel = await result;
    expect(tunnel.publicUrl).toBe("https://auth.ngrok.io/hook");
    expect(tunnel.provider).toBe("ngrok");
    expect(mocks.spawn).toHaveBeenCalledWith(
      "ngrok",
      ["http", "3334", "--log", "stdout", "--log-format", "json"],
      expect.objectContaining({
        env: expect.objectContaining({ NGROK_AUTHTOKEN: "token" }),
      }),
    );
  });

  it("rejects ngrok startup errors from stderr", async () => {
    const proc = nextProcess();
    const result = startNgrokTunnel({ port: 3334, path: "/hook" });

    proc.stderr.write("ERR_NGROK_3200: invalid auth token");

    await expect(result).rejects.toThrow("ngrok error: ERR_NGROK_3200: invalid auth token");
  });

  it("preserves split ngrok errors across a UTF-16-safe bounded tail", async () => {
    const proc = nextProcess();
    const result = startNgrokTunnel({ port: 3334, path: "/hook" });
    const firstChunk = "🤖xERR_NG";

    // A raw marker-length tail starts on the low surrogate. Production must
    // discard that dangling half while retaining the split marker prefix.
    expect(firstChunk.slice(-8).charCodeAt(0)).toBe(0xdd16);
    proc.stderr.write(firstChunk);
    proc.stderr.write("ROK_108: invalid tunnel config");

    await expect(result).rejects.toThrow("ngrok error: xERR_NGROK_108: invalid tunnel config");
  });

  it("preserves UTF-8 across real child stderr pipe chunks", async () => {
    const message = "bad 😀 ERR_NGROK_3200: invalid token";
    const { splitAt } = midEmojiSplit(message);
    mockSpawnUtf8SplitChild({ stream: "stderr", text: message, splitAt });
    const result = startNgrokTunnel({ port: 3334, path: "/hook" });

    await expect(result).rejects.toThrow(`ngrok error: ${message}`);
  });

  it("preserves UTF-8 across real child stdout pipe chunks", async () => {
    const line = '{"msg":"started tunnel","url":"https://utf8.ngrok.io","info":"😀"}\n';
    const { splitAt } = midEmojiSplit(line);
    mockSpawnUtf8SplitChild({ stream: "stdout", text: line, splitAt });
    const tunnel = await startNgrokTunnel({ port: 3334, path: "/voice/webhook" });

    expect(tunnel.publicUrl).toBe("https://utf8.ngrok.io/voice/webhook");
    await tunnel.stop();
  });

  it("routes Tailscale Funnel setup and cleanup through the shared exposure owner", async () => {
    mocks.setupTailscaleExposureRoutes.mockResolvedValue(
      "https://host.tailnet.ts.net:8443/voice/webhook",
    );
    const tunnel = await startTailscaleTunnel({
      mode: "funnel",
      port: 3334,
      path: "voice/webhook",
      tailscalePort: 8443,
      streamPaths: [
        {
          publicPath: "voice/stream/realtime",
          localPath: "voice/stream/realtime",
        },
      ],
    });

    expect(tunnel.publicUrl).toBe("https://host.tailnet.ts.net:8443/voice/webhook");
    expect(tunnel.provider).toBe("tailscale-funnel");
    expect(mocks.setupTailscaleExposureRoutes).toHaveBeenCalledWith({
      mode: "funnel",
      port: 8443,
      routes: [
        {
          path: "/voice/webhook",
          localUrl: "http://127.0.0.1:3334/voice/webhook",
        },
        {
          path: "/voice/stream/realtime",
          localUrl: "http://127.0.0.1:3334/voice/stream/realtime",
        },
      ],
    });

    await tunnel.stop();

    expect(mocks.cleanupTailscaleExposureRoute.mock.calls).toEqual([
      [{ mode: "funnel", port: 8443, path: "/voice/webhook" }],
      [{ mode: "funnel", port: 8443, path: "/voice/stream/realtime" }],
    ]);
  });

  it("rejects when the shared Tailscale exposure owner cannot mount the routes", async () => {
    mocks.setupTailscaleExposureRoutes.mockResolvedValue(null);

    await expect(
      startTailscaleTunnel({ mode: "funnel", port: 3334, path: "/hook" }),
    ).rejects.toThrow("Tailscale funnel failed");
  });

  it("dispatches tunnel providers from config", async () => {
    await expect(startTunnel({ provider: "none", port: 3334, path: "/hook" })).resolves.toBeNull();

    const proc = nextProcess();
    const result = startTunnel({ provider: "ngrok", port: 3334, path: "/hook" });
    emitNgrokUrl(proc, "https://dispatch.ngrok.io");

    const tunnel = await result;
    expect(tunnel?.publicUrl).toBe("https://dispatch.ngrok.io/hook");
    expect(tunnel?.provider).toBe("ngrok");
  });

  it("rejects when ngrok stdout emits an error before the tunnel is ready", async () => {
    const proc = nextProcess();
    const result = startNgrokTunnel({ port: 3334, path: "/hook" });
    proc.stdout.emit("error", new Error("EPIPE"));
    await expect(result).rejects.toThrow("ngrok stdout error: EPIPE");
    expect(proc.killedWith).toBe("SIGKILL");
  });

  it("rejects when ngrok stderr emits an error before the tunnel is ready", async () => {
    const proc = nextProcess();
    const result = startNgrokTunnel({ port: 3334, path: "/hook" });
    proc.stderr.emit("error", new Error("EIO"));
    await expect(result).rejects.toThrow("ngrok stderr error: EIO");
    expect(proc.killedWith).toBe("SIGKILL");
  });

  it("stops immediately when the ngrok process already exited", async () => {
    const proc = nextProcess();
    const result = startNgrokTunnel({ port: 3334, path: "/hook" });
    emitNgrokUrl(proc, "https://early-exit.ngrok.io");
    const tunnel = await result;
    proc.emit("close", 0);
    await expect(tunnel.stop()).resolves.toBeUndefined();
    expect(proc.killedWith).toBeNull();
  });
});
