// Covers SSH target parsing and tunnel startup preflight behavior.
import { EventEmitter } from "node:events";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";

const mocks = vi.hoisted(() => ({
  ensurePortAvailable: vi.fn<(port: number, host?: string) => Promise<void>>(),
  resolveSshClient: vi.fn<() => string | null>(() => "/usr/bin/ssh"),
  spawn: vi.fn(),
}));

vi.mock("./ports.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ports.js")>()),
  ensurePortAvailable: mocks.ensurePortAvailable,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));

vi.mock("./ssh-client.js", () => ({
  resolveSshClient: mocks.resolveSshClient,
}));

import { getFreePort } from "../test-utils/ports.js";
import { PortInUseError } from "./ports.js";
import { parseSshTarget, startSshPortForward } from "./ssh-tunnel.js";

describe("parseSshTarget", () => {
  it("parses user@host:port targets", () => {
    expect(parseSshTarget("me@example.com:2222")).toEqual({
      user: "me",
      host: "example.com",
      port: 2222,
    });
  });

  it("strips an ssh prefix and keeps the default port when missing", () => {
    expect(parseSshTarget(" ssh alice@example.com ")).toEqual({
      user: "alice",
      host: "example.com",
      port: 22,
    });
  });

  it("preserves OpenSSH alias and username tokens", () => {
    expect(parseSshTarget("me+prod@prod+gpu:2222")).toEqual({
      user: "me+prod",
      host: "prod+gpu",
      port: 2222,
    });
    expect(parseSshTarget(String.raw`DOMAIN\alice@jump+gpu`)).toEqual({
      user: String.raw`DOMAIN\alice`,
      host: "jump+gpu",
      port: 22,
    });
  });

  it("rejects invalid hosts and ports", () => {
    expect(parseSshTarget("")).toBeNull();
    expect(parseSshTarget("me@example.com:0")).toBeNull();
    expect(parseSshTarget("me@example.com:22abc")).toBeNull();
    expect(parseSshTarget("me@example.com:70000")).toBeNull();
    expect(parseSshTarget("me@example.com:not-a-port")).toBeNull();
    expect(parseSshTarget("-V")).toBeNull();
    expect(parseSshTarget("me@-badhost")).toBeNull();
    expect(parseSshTarget("-oProxyCommand=touch@example.com")).toBeNull();
    expect(parseSshTarget("-oProxyCommand=echo")).toBeNull();
  });

  it("rejects targets that cannot be embedded in ssh config directives", () => {
    expect(parseSshTarget("example.com\n  ProxyCommand touch marker")).toBeNull();
    expect(parseSshTarget("example.com\r  ProxyCommand touch marker")).toBeNull();
    expect(parseSshTarget("example.com\n  ProxyCommand touch marker:2222")).toBeNull();
    expect(parseSshTarget("me\nProxyCommand=touch@example.com")).toBeNull();
    expect(parseSshTarget("bad host")).toBeNull();
    expect(parseSshTarget("me name@example.com")).toBeNull();
  });

  it("rejects hostnames with stray leading or trailing colons", () => {
    // Default-port branch: the whole host part keeps the stray colon.
    expect(parseSshTarget("host:")).toBeNull();
    expect(parseSshTarget(":22")).toBeNull();
    expect(parseSshTarget("user@:22")).toBeNull();
    expect(parseSshTarget("user@host:")).toBeNull();
    // Explicit-port branch: the port split slices a stray colon into the host.
    expect(parseSshTarget("host::22")).toBeNull();
    expect(parseSshTarget(":host:22")).toBeNull();
  });
});

describe("startSshPortForward", () => {
  const openServers: net.Server[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    while (openServers.length > 0) {
      const server = openServers.pop();
      await new Promise<void>((resolve) => {
        server?.close(() => resolve());
      });
    }
    mocks.ensurePortAvailable.mockReset();
    mocks.resolveSshClient.mockReset();
    mocks.resolveSshClient.mockReturnValue("/usr/bin/ssh");
    mocks.spawn.mockReset();
  });

  // A synthetic child can open a real loopback listener or stall until cancellation.
  function spawnFakeSsh({ listen = true } = {}) {
    mocks.spawn.mockImplementation((_cmd: string, args: string[]) => {
      const forwardSpec = args[args.indexOf("-L") + 1] ?? "";
      const localPort = Number(forwardSpec.split(":")[1]);
      if (listen) {
        const server = net.createServer();
        server.on("error", () => {});
        openServers.push(server);
        server.listen(localPort, "127.0.0.1");
      }

      const child = new EventEmitter() as EventEmitter & {
        killed: boolean;
        pid: number;
        stderr: EventEmitter & { setEncoding: (enc: string) => void };
        kill: (signal?: string) => boolean;
      };
      child.killed = false;
      child.pid = 4242;
      const stderr = new EventEmitter() as EventEmitter & { setEncoding: (enc: string) => void };
      stderr.setEncoding = () => {};
      child.stderr = stderr;
      child.kill = (signal?: string) => {
        child.killed = true;
        queueMicrotask(() => child.emit("exit", 0, signal ?? null));
        return true;
      };
      return child;
    });
  }

  it("fails before port probing when no trusted SSH client is installed", async () => {
    mocks.resolveSshClient.mockReturnValueOnce(null);

    await expect(
      startSshPortForward({
        target: "me@example.com",
        localPortPreferred: 43210,
        remotePort: 18789,
        timeoutMs: 250,
      }),
    ).rejects.toThrow("trusted SSH client not found in system directories");

    expect(mocks.ensurePortAvailable).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("scopes the preferred-port preflight to the IPv4 loopback interface", async () => {
    const sentinel = new Error("stop before spawning ssh");
    mocks.ensurePortAvailable.mockRejectedValueOnce(sentinel);

    await expect(
      startSshPortForward({
        target: "me@example.com:2222",
        localPortPreferred: 43210,
        remotePort: 18789,
        timeoutMs: 250,
      }),
    ).rejects.toBe(sentinel);

    expect(mocks.ensurePortAvailable).toHaveBeenCalledWith(43210, "127.0.0.1");
  });

  it("falls back to an ephemeral port when the preferred port is in use", async () => {
    // ensurePortAvailable raises the domain PortInUseError (no errno `code`),
    // which the catch must treat as "busy" and allocate another port.
    // Reserve a real port so the ephemeral listener cannot hand the same
    // number back and make the assertion flaky.
    const occupied = net.createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", () => {
        occupied.off("error", reject);
        resolve();
      });
    });
    openServers.push(occupied);
    const addr = occupied.address();
    if (!addr || typeof addr === "string") {
      throw new Error("failed to reserve preferred port");
    }
    const preferredPort = addr.port;

    mocks.ensurePortAvailable.mockRejectedValueOnce(new PortInUseError(preferredPort));
    spawnFakeSsh();

    const tunnel = await startSshPortForward({
      target: "me@example.com:2222",
      localPortPreferred: preferredPort,
      remotePort: 18789,
      timeoutMs: 1000,
    });

    expect(tunnel.localPort).not.toBe(preferredPort);
    expect(tunnel.localPort).toBeGreaterThan(0);
    expect(mocks.spawn).toHaveBeenCalledWith(
      "/usr/bin/ssh",
      expect.arrayContaining(["-L", `127.0.0.1:${tunnel.localPort}:127.0.0.1:18789`]),
      expect.anything(),
    );

    await tunnel.stop();
  });

  it.each(["term", "kill"] as const)(
    "keeps every stop caller pending until the child exits after %s",
    async (exitAfter) => {
      spawnFakeSsh();
      const tunnel = await startSshPortForward({
        target: "me@example.com:2222",
        localPortPreferred: await getFreePort(),
        remotePort: 18789,
        timeoutMs: 1000,
      });
      const child = mocks.spawn.mock.results[0]?.value as EventEmitter & {
        killed: boolean;
        kill: (signal?: string) => boolean;
      };
      const signals: string[] = [];
      child.kill = (signal = "SIGTERM") => {
        child.killed = true;
        signals.push(signal);
        return true;
      };
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const settled: number[] = [];
      const waits = [
        tunnel.stop().then(() => settled.push(1)),
        tunnel.stop().then(() => settled.push(2)),
      ];
      try {
        await vi.advanceTimersByTimeAsync(exitAfter === "kill" ? 1500 : 0);
        expect(signals).toEqual(exitAfter === "kill" ? ["SIGTERM", "SIGKILL"] : ["SIGTERM"]);
        expect(settled).toEqual([]);
        child.emit("exit", null, exitAfter === "kill" ? "SIGKILL" : "SIGTERM");
        await Promise.all(waits);
        expect(settled).toHaveLength(2);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        child.emit("exit", null, "SIGTERM");
        child.emit("close", null, "SIGTERM");
        await Promise.all(waits);
        vi.useRealTimers();
      }
    },
  );

  it("stops an established tunnel when its owner aborts", async () => {
    spawnFakeSsh();
    const controller = new AbortController();
    const tunnel = await startSshPortForward({
      target: "me@example.com:2222",
      localPortPreferred: await getFreePort(),
      remotePort: 18789,
      timeoutMs: 1000,
      signal: controller.signal,
    });
    const child = mocks.spawn.mock.results[0]?.value as EventEmitter & { killed: boolean };

    controller.abort();

    await vi.waitFor(() => expect(child.killed).toBe(true));
    await expect(tunnel.stop()).resolves.toBeUndefined();
  });

  it("keeps startup abort pending until the SSH child exits", async () => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stderr: EventEmitter & { setEncoding: (enc: string) => void };
      kill: (signal?: string) => boolean;
    };
    child.pid = 4242;
    child.stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
    child.kill = vi.fn(() => true);
    mocks.spawn.mockReturnValue(child);
    const controller = new AbortController();
    const forwarding = startSshPortForward({
      target: "me@example.com:2222",
      localPortPreferred: await getFreePort(),
      remotePort: 18789,
      timeoutMs: 1000,
      signal: controller.signal,
    });
    let settled = false;
    void forwarding
      .finally(() => {
        settled = true;
      })
      .catch(() => {});

    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1));
    controller.abort();
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGTERM"));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(child.kill).toHaveBeenCalledTimes(1);

    child.emit("exit", null, "SIGTERM");
    await expect(forwarding).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each(
    ["error", "exit", "abort"].flatMap((terminal) =>
      ["socket", "retry"].map((pending) => ({ terminal, pending })),
    ),
  )(
    "joins pending readiness $pending before startup rejects on $terminal",
    async ({ terminal, pending }) => {
      const localPort = await getFreePort();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const spawnError = new Error("ENOENT: no such file or directory, spawn /usr/bin/ssh");
      (spawnError as NodeJS.ErrnoException).code = "ENOENT";
      const child = Object.assign(new EventEmitter(), {
        stderr: Object.assign(new EventEmitter(), { setEncoding: () => {} }),
        kill: vi.fn(() => {
          queueMicrotask(() => child.emit("close", -2, null));
          return false;
        }),
      });
      mocks.spawn.mockReturnValue(child);
      const controller = new AbortController();
      const abortReason = new Error("startup owner stopped");
      const socketCreated = createDeferred<net.Socket>();
      const retryScheduled = createDeferred();
      const connect = net.connect;
      const connectSpy = vi.spyOn(net, "connect").mockImplementation((...args) => {
        // Real refusal exercises the retry; an unconnected Socket holds the other
        // case at pending I/O without depending on network timing or a remote host.
        const socket = pending === "retry" ? connect(...args) : new net.Socket();
        socketCreated.resolve(socket);
        return socket;
      });
      const schedule = globalThis.setTimeout;
      const timerSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((...args) => {
        const timer = schedule(...args);
        retryScheduled.resolve();
        return timer;
      });
      const forwarding = startSshPortForward({
        target: "me@example.com:2222",
        localPortPreferred: localPort,
        remotePort: 18789,
        timeoutMs: 500,
        signal: controller.signal,
      });
      const rejection = expect(forwarding).rejects.toMatchObject(
        terminal === "error"
          ? { message: expect.stringContaining("ENOENT"), cause: spawnError }
          : terminal === "exit"
            ? { message: "ssh exited (1)", cause: expect.any(Error) }
            : { name: "AbortError", cause: abortReason },
      );
      const socket = await socketCreated.promise;
      try {
        if (pending === "retry") {
          await retryScheduled.promise;
          expect(socket.destroyed).toBe(true);
          expect(vi.getTimerCount()).toBe(1);
        }
        if (terminal === "abort") {
          controller.abort(abortReason);
        } else if (terminal === "error") {
          child.emit("error", spawnError);
        } else {
          child.emit("exit", 1, null);
        }
        await rejection;
        expect(socket.closed).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        expect(child.kill).toHaveBeenCalledWith("SIGTERM");
        await vi.advanceTimersByTimeAsync(500);
        expect(connectSpy).toHaveBeenCalledTimes(1);
      } finally {
        socket.destroy();
        timerSpy.mockRestore();
        connectSpy.mockRestore();
        vi.clearAllTimers();
      }
    },
  );

  it.each([10_000, -10_000])(
    "keeps the startup budget through a %s ms wall-clock step",
    async (stepMs) => {
      spawnFakeSsh({ listen: false });
      const localPort = await getFreePort();
      const controller = new AbortController();
      const now = Date.now;
      let offset = 0;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + offset);
      const connect = net.connect;
      const probe = vi.spyOn(net, "connect").mockImplementation((...args) => {
        // Move wall time only after the owner's initial budget timestamp is captured.
        offset = stepMs;
        return connect(...args);
      });
      const safety = setTimeout(() => controller.abort(), 1000);
      const started = performance.now();
      try {
        await expect(
          startSshPortForward({
            target: "me@example.com:2222",
            localPortPreferred: localPort,
            remotePort: 18789,
            timeoutMs: 250,
            signal: controller.signal,
          }),
        ).rejects.toThrow("ssh tunnel did not start listening");
        expect(performance.now() - started).toBeGreaterThanOrEqual(200);
      } finally {
        clearTimeout(safety);
        controller.abort();
        clock.mockRestore();
        probe.mockRestore();
      }
    },
  );

  it.each(["active", "teardown"] as const)(
    "does not crash when stderr errors while the tunnel is %s",
    async (phase) => {
      // Real timers only. The fake spawn opens a real socket, and
      // waitForLocalListener retries on setTimeout against a monotonic budget.
      // Under fake timers neither advances, so a listener that loses the race on the
      // first probe hangs to the suite timeout instead of failing on its own budget.
      spawnFakeSsh();
      const localPort = await getFreePort();

      const tunnel = await startSshPortForward({
        target: "me@example.com:2222",
        localPortPreferred: localPort,
        remotePort: 18789,
        timeoutMs: 1000,
      });

      const child = mocks.spawn.mock.results[0]?.value as EventEmitter & {
        killed: boolean;
        stderr: EventEmitter;
      };
      const stopping = phase === "teardown" ? tunnel.stop() : undefined;
      expect(child.killed).toBe(phase === "teardown");
      expect(() => child.stderr.emit("error", new Error("stderr EPIPE"))).not.toThrow();

      await expect(stopping ?? tunnel.stop()).resolves.toBeUndefined();
    },
  );
});
