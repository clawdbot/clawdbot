import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const launcherPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "daytona-exec-launcher.mjs",
);

const loadLauncher = async () =>
  (await import(pathToFileURL(launcherPath).href)) as {
    decodePayload: (argv: string[]) => unknown;
    shellEscape: (value: string) => string;
    buildSessionCommand: (command: string, env?: Record<string, string>) => string;
    registerCleanupSignals: (
      cleanup: () => Promise<unknown>,
      options?: {
        onSignal?: (signal: string, handler: () => void) => void;
        exit?: (code: number) => void;
      },
    ) => { interrupted: string | null };
    runSessionExec: (
      sandbox: {
        process: {
          createSession: ReturnType<typeof vi.fn>;
          executeSessionCommand: ReturnType<typeof vi.fn>;
          deleteSession: ReturnType<typeof vi.fn>;
        };
      },
      payload: { command: string },
      options?: {
        onSignal?: (signal: string, handler: () => void) => void;
        exit?: (code: number) => void;
      },
    ) => Promise<number>;
    runPtyExec: (
      sandbox: {
        process: {
          createPty: ReturnType<typeof vi.fn>;
          killPtySession: ReturnType<typeof vi.fn>;
        };
      },
      payload: { command: string; cwd: string; env: Record<string, string> },
      options?: {
        onSignal?: (signal: string, handler: () => void) => void;
        exit?: (code: number) => void;
        stdin?: EventEmitter & { resume: () => void };
      },
    ) => Promise<number>;
  };

describe("daytona exec launcher", () => {
  it("decodes the payload file and removes the payload directory", async () => {
    const launcher = await loadLauncher();
    const payloadDir = mkdtempSync(path.join(tmpdir(), "daytona-launcher-test-"));
    const payloadFile = path.join(payloadDir, "payload.json");
    writeFileSync(payloadFile, JSON.stringify({ sandboxId: "sbx-1", usePty: false }));

    const payload = launcher.decodePayload(["--payload-file", payloadFile]);

    expect(payload).toEqual({ sandboxId: "sbx-1", usePty: false });
    expect(existsSync(payloadDir)).toBe(false);
  });

  it("rejects missing payload arguments", async () => {
    const launcher = await loadLauncher();
    expect(() => launcher.decodePayload([])).toThrow("Missing --payload-file");
    expect(() => launcher.decodePayload(["--payload-file"])).toThrow(
      "Missing --payload-file value",
    );
  });

  it("escapes shell words for the PTY exec wrapper", async () => {
    const launcher = await loadLauncher();
    expect(launcher.shellEscape("plain")).toBe("'plain'");
    expect(launcher.shellEscape("with 'quote'")).toBe(`'with '"'"'quote'"'"''`);
  });

  it("stages session environment without putting values in launcher argv", async () => {
    const launcher = await loadLauncher();
    expect(launcher.buildSessionCommand("printf ok", { TOKEN: "a'b" })).toBe(
      `export TOKEN='a'"'"'b'; exec printf ok`,
    );
    expect(() => launcher.buildSessionCommand("true", { "BAD-NAME": "1" })).toThrow(
      "use a POSIX variable name",
    );
    expect(() => launcher.buildSessionCommand("true", { TOKEN: "bad\0value" })).toThrow(
      "must not contain NUL bytes",
    );
  });

  it("runs remote cleanup before exiting when a signal arrives", async () => {
    const launcher = await loadLauncher();
    const events: string[] = [];
    const handlers = new Map<string, () => void>();
    let resolveCleanup: (() => void) | undefined;
    const cleanup = () => {
      events.push("cleanup-start");
      return new Promise<void>((resolve) => {
        resolveCleanup = () => {
          events.push("cleanup-done");
          resolve();
        };
      });
    };

    const state = launcher.registerCleanupSignals(cleanup, {
      onSignal: (signal, handler) => handlers.set(signal, handler),
      exit: (code) => events.push(`exit-${code}`),
    });

    // Handlers for every forwarded signal are armed synchronously, before any
    // remote startup call could have been awaited.
    expect([...handlers.keys()].toSorted()).toEqual(["SIGHUP", "SIGINT", "SIGTERM"]);
    expect(state.interrupted).toBeNull();

    handlers.get("SIGTERM")?.();
    expect(state.interrupted).toBe("SIGTERM");
    expect(events).toEqual(["cleanup-start"]);
    resolveCleanup?.();
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    // Exit happens only after the remote cleanup settled.
    expect(events).toEqual(["cleanup-start", "cleanup-done", "exit-143"]);
  });

  it("does not submit a command when signalled during session creation", async () => {
    const launcher = await loadLauncher();
    const handlers = new Map<string, () => void>();
    let releaseSession: (() => void) | undefined;
    const sandbox = {
      process: {
        createSession: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              releaseSession = resolve;
            }),
        ),
        executeSessionCommand: vi.fn(),
        deleteSession: vi.fn(async () => {}),
      },
    };

    const pending = launcher.runSessionExec(
      sandbox,
      { command: "touch should-not-exist" },
      {
        onSignal: (signal, handler) => handlers.set(signal, handler),
        exit: () => {},
      },
    );
    await vi.waitFor(() => expect(releaseSession).toBeTypeOf("function"));
    handlers.get("SIGTERM")?.();
    releaseSession?.();

    await expect(pending).resolves.toBe(143);
    expect(sandbox.process.executeSessionCommand).not.toHaveBeenCalled();
  });

  it("kills and disconnects a PTY when startup input fails", async () => {
    const launcher = await loadLauncher();
    const ptyHandle = {
      waitForConnection: vi.fn(async () => {}),
      sendInput: vi.fn(async () => {
        throw new Error("send failed");
      }),
      disconnect: vi.fn(async () => {}),
    };
    const sandbox = {
      process: {
        createPty: vi.fn(async (_options: { id: string }) => ptyHandle),
        killPtySession: vi.fn(async () => {}),
      },
    };

    await expect(
      launcher.runPtyExec(
        sandbox,
        { command: "true", cwd: "/workspace", env: {} },
        { onSignal: () => {}, exit: () => {} },
      ),
    ).rejects.toThrow("send failed");

    const ptyId = sandbox.process.createPty.mock.calls[0]?.[0]?.id;
    expect(ptyId).toMatch(/^openclaw-pty-/u);
    expect(sandbox.process.killPtySession).toHaveBeenCalledWith(ptyId);
    expect(ptyHandle.disconnect).toHaveBeenCalledTimes(1);
  });

  it("waits for PTY termination before returning after a signal", async () => {
    const launcher = await loadLauncher();
    const handlers = new Map<string, () => void>();
    let resolveWait: ((result: { exitCode: number }) => void) | undefined;
    let resolveKill: (() => void) | undefined;
    const ptyHandle = {
      waitForConnection: vi.fn(async () => {}),
      sendInput: vi.fn(async () => {}),
      wait: vi.fn(
        () =>
          new Promise<{ exitCode: number }>((resolve) => {
            resolveWait = resolve;
          }),
      ),
      disconnect: vi.fn(async () => {}),
    };
    const sandbox = {
      process: {
        createPty: vi.fn(async (_options: { id: string }) => ptyHandle),
        killPtySession: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              resolveKill = resolve;
            }),
        ),
      },
    };

    const pending = launcher.runPtyExec(
      sandbox,
      { command: "sleep 30", cwd: "/workspace", env: {} },
      {
        onSignal: (signal, handler) => handlers.set(signal, handler),
        exit: () => {},
      },
    );
    await vi.waitFor(() => expect(ptyHandle.wait).toHaveBeenCalledTimes(1));

    handlers.get("SIGTERM")?.();
    resolveWait?.({ exitCode: 0 });
    const settled = vi.fn();
    void pending.then(settled, settled);
    await vi.waitFor(() => expect(sandbox.process.killPtySession).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(settled).not.toHaveBeenCalled();

    resolveKill?.();
    await expect(pending).resolves.toBe(143);
    expect(ptyHandle.disconnect).toHaveBeenCalledTimes(1);
  });

  it("forwards stdin data before EOF to a Daytona PTY", async () => {
    const launcher = await loadLauncher();
    const stdin = Object.assign(new EventEmitter(), { resume: vi.fn() });
    let resolveWait: ((result: { exitCode: number }) => void) | undefined;
    let resolveData: (() => void) | undefined;
    const ptyHandle = {
      waitForConnection: vi.fn(async () => {}),
      sendInput: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              resolveData = resolve;
            }),
        )
        .mockResolvedValue(undefined),
      wait: vi.fn(
        () =>
          new Promise<{ exitCode: number }>((resolve) => {
            resolveWait = resolve;
          }),
      ),
      disconnect: vi.fn(async () => {}),
    };
    const sandbox = {
      process: {
        createPty: vi.fn(async () => ptyHandle),
        killPtySession: vi.fn(async () => {}),
      },
    };

    const pending = launcher.runPtyExec(
      sandbox,
      { command: "cat", cwd: "/workspace", env: {} },
      { onSignal: () => {}, exit: () => {}, stdin },
    );
    await vi.waitFor(() => expect(ptyHandle.wait).toHaveBeenCalledTimes(1));

    stdin.emit("data", Buffer.from("hello"));
    stdin.emit("end");
    await vi.waitFor(() => expect(ptyHandle.sendInput).toHaveBeenCalledTimes(2));

    resolveData?.();
    await vi.waitFor(() => expect(ptyHandle.sendInput).toHaveBeenLastCalledWith("\x04"));

    resolveWait?.({ exitCode: 0 });
    await expect(pending).resolves.toBe(0);
  });
});
