import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginNodeHostCommandIo } from "../plugins/types.js";
import { decodeNodePtyResumeParams, runNodePtyCommand } from "./pty-command.js";

type TerminalPtyHandle = Awaited<ReturnType<NonNullable<Parameters<typeof runNodePtyCommand>[2]>>>;

describe("node PTY command", () => {
  it("validates closed resume params", () => {
    const validate = (value: unknown) => {
      if (typeof value !== "string" || !value) {
        throw new Error("bad thread");
      }
      return value;
    };
    expect(decodeNodePtyResumeParams('{"threadId":"id","cols":80,"rows":24}', validate)).toEqual({
      threadId: "id",
      cols: 80,
      rows: 24,
    });
    expect(() =>
      decodeNodePtyResumeParams('{"threadId":"id","cols":80,"rows":24,"argv":["sh"]}', validate),
    ).toThrow("unknown terminal resume parameter: argv");
  });

  it("relays output, data, resize, abort, and exit", async () => {
    let onData: ((chunk: string) => void) | undefined;
    let onExit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
    let onInput: ((payloadJSON: string) => void) | undefined;
    const pty = {
      pid: 42,
      write: vi.fn(),
      resize: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      kill: vi.fn(),
      onData: (callback: (chunk: string) => void) => {
        onData = callback;
      },
      onExit: (callback: (event: { exitCode: number; signal?: number }) => void) => {
        onExit = callback;
      },
    } satisfies TerminalPtyHandle;
    const abort = new AbortController();
    const emitChunk = vi.fn(async () => {});
    const io: OpenClawPluginNodeHostCommandIo = {
      signal: abort.signal,
      emitChunk,
      onInput: (callback) => {
        onInput = callback;
      },
    };
    const spawn = vi.fn(async () => pty);
    const result = runNodePtyCommand(
      {
        file: "/usr/bin/codex",
        args: ["resume", "id"],
        cwd: "/missing/catalog/cwd",
        pathEnv: "/shell/bin:/usr/bin",
        cols: 80,
        rows: 24,
      },
      io,
      spawn,
    );
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    const spawnCalls = spawn.mock.calls as unknown as Array<
      [{ cwd?: string; env?: Record<string, string> }]
    >;
    expect(spawnCalls[0]?.[0].cwd).toBe(os.homedir());
    expect(spawnCalls[0]?.[0].env?.PATH).toBe("/shell/bin:/usr/bin");

    onData?.("output");
    await vi.waitFor(() => expect(emitChunk).toHaveBeenCalledWith("output"));
    expect(pty.pause).toHaveBeenCalledOnce();
    expect(pty.resume).toHaveBeenCalledOnce();
    onInput?.(JSON.stringify({ kind: "resize", cols: 0, rows: 30 }));
    onInput?.(JSON.stringify({ kind: "resize", cols: 80, rows: 2001 }));
    expect(pty.resize).not.toHaveBeenCalled();
    onInput?.(JSON.stringify({ kind: "data", data: "keys" }));
    onInput?.(JSON.stringify({ kind: "resize", cols: 100, rows: 30 }));
    expect(pty.write).toHaveBeenCalledWith("keys");
    expect(pty.resize).toHaveBeenCalledWith(100, 30);

    abort.abort();
    expect(pty.kill).toHaveBeenCalledOnce();
    onInput?.(JSON.stringify({ kind: "data", data: "after abort" }));
    onInput?.(JSON.stringify({ kind: "resize", cols: 120, rows: 40 }));
    expect(pty.write).toHaveBeenCalledTimes(1);
    expect(pty.resize).toHaveBeenCalledTimes(1);
    onExit?.({ exitCode: 130, signal: 15 });
    await expect(result).resolves.toEqual({ exitCode: 130, signal: 15 });
  });

  it("ignores input after exit without touching a dead PTY", async () => {
    let onExit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
    let onInput: ((payloadJSON: string) => void) | undefined;
    const pty = {
      pid: 42,
      write: vi.fn(() => {
        throw new Error("dead PTY write");
      }),
      resize: vi.fn(() => {
        throw new Error("dead PTY resize");
      }),
      pause: vi.fn(),
      resume: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(),
      onExit: (callback: (event: { exitCode: number; signal?: number }) => void) => {
        onExit = callback;
      },
    } satisfies TerminalPtyHandle;
    const io: OpenClawPluginNodeHostCommandIo = {
      signal: new AbortController().signal,
      emitChunk: vi.fn(async () => {}),
      onInput: (callback) => {
        onInput = callback;
      },
    };
    const result = runNodePtyCommand(
      { file: "/usr/bin/codex", args: [], cols: 80, rows: 24 },
      io,
      vi.fn(async () => pty),
    );
    await vi.waitFor(() => expect(onInput).toBeDefined());

    expect(() => onInput?.(JSON.stringify({ kind: "data", data: "racing" }))).not.toThrow();
    expect(() => onInput?.(JSON.stringify({ kind: "resize", cols: 100, rows: 30 }))).not.toThrow();
    expect(pty.write).toHaveBeenCalledOnce();
    expect(pty.resize).toHaveBeenCalledOnce();
    pty.write.mockClear();
    pty.resize.mockClear();

    onExit?.({ exitCode: 0 });
    expect(() => onInput?.(JSON.stringify({ kind: "data", data: "late" }))).not.toThrow();
    expect(() => onInput?.(JSON.stringify({ kind: "resize", cols: 100, rows: 30 }))).not.toThrow();

    await expect(result).resolves.toEqual({ exitCode: 0 });
    expect(pty.write).not.toHaveBeenCalled();
    expect(pty.resize).not.toHaveBeenCalled();
  });
});
