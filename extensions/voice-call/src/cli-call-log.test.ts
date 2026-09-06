import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

const { sleepMock, historyMock } = vi.hoisted(() => ({
  sleepMock: vi.fn(),
  historyMock: vi.fn(),
}));
vi.mock("../api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api.js")>()),
  sleep: sleepMock,
}));
vi.mock("./manager/store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./manager/store.js")>()),
  getCallHistoryFromStore: historyMock,
}));

import { registerVoiceCallLogs } from "./cli-call-log.js";

describe("voice-call diagnostic stream ownership", () => {
  let workspace: Awaited<ReturnType<typeof tempWorkspace>>;
  let file: string;
  let output: Buffer[];
  let stdout: MockInstance<typeof process.stdout.write>;
  const stopped = new Error("diagnostic test finished");

  beforeEach(async () => {
    workspace = await tempWorkspace({ rootDir: os.tmpdir(), prefix: "voice-call-log-" });
    file = await workspace.write("diagnostics.jsonl", "");
    output = [];
    sleepMock.mockReset().mockRejectedValue(stopped);
    historyMock.mockReset().mockResolvedValue([]);
    stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk)));
      return true;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await workspace.cleanup();
  });

  function command(...args: string[]) {
    const program = new Command();
    registerVoiceCallLogs({ root: program, defaultFile: file, ensureHistoryStateRuntime() {} });
    return program.parseAsync(args, { from: "user" });
  }

  function text() {
    return Buffer.concat(output).toString("utf8");
  }

  it.each(["tail", "latency"])(
    "preserves requested %s history beyond one megabyte without reading the whole file",
    async (mode) => {
      const records = [120, 240, 360].map((latency) =>
        JSON.stringify({ metadata: { lastTurnLatencyMs: latency }, padding: "x".repeat(600_000) }),
      );
      fs.writeFileSync(file, `${records.join("\n")}\n`);
      const readFile = vi.spyOn(fs, "readFileSync");
      if (mode === "tail") {
        await expect(command("tail", "--since", "3")).rejects.toBe(stopped);
        expect(text()).toBe(`${records.join("\n")}\n`);
      } else {
        await command("latency", "--last", "3");
        expect(JSON.parse(text())).toMatchObject({
          recordsScanned: 3,
          turnLatency: { count: 3, avgMs: 240, minMs: 120, maxMs: 360 },
        });
      }
      expect(readFile.mock.calls.filter(([target]) => target === file)).toEqual([]);
    },
  );

  it("bounds follow reads while retaining every record and the unfinished suffix", async () => {
    const records = Array.from({ length: 2048 }, (_, seq) =>
      JSON.stringify({ seq, text: "é".repeat(512) }),
    );
    const read = vi.spyOn(fs, "readSync");
    sleepMock
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        fs.appendFileSync(file, `${records.join("\n")}\n{"seq":2048`);
      })
      .mockImplementationOnce(async () => {
        fs.appendFileSync(file, "}\n");
      });
    await expect(command("tail", "--since", "0")).rejects.toBe(stopped);
    expect(text()).toBe(`${records.join("\n")}\n{"seq":2048}\n`);
    const requested = read.mock.calls.map(([, buffer]) => buffer.byteLength);
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.every((length) => length <= 64 * 1024)).toBe(true);
  });

  it("does not join a pending record to a larger replacement file", async () => {
    fs.writeFileSync(file, '{"seq":0}\n{"retired":');
    const replacement = `${JSON.stringify({ seq: 1, text: "fresh".repeat(64) })}\n`;
    sleepMock.mockImplementationOnce(async () => {
      const next = await workspace.write("replacement.jsonl", replacement);
      fs.renameSync(next, file);
    });
    await expect(command("tail", "--since", "1")).rejects.toBe(stopped);
    expect(text()).toBe(`{"seq":0}\n${replacement}`);
  });

  it("stops producing until stdout drains", async () => {
    fs.writeFileSync(file, '{"seq":0}\n{"seq":1}\n');
    const blocked = createDeferred<void>();
    let rejectWrites = true;
    stdout.mockImplementation((chunk) => {
      output.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk)));
      if (rejectWrites) {
        blocked.resolve();
        return false;
      }
      return true;
    });
    const running = command("tail", "--since", "2").catch((error: unknown) => error);
    await blocked.promise;
    try {
      expect(text()).not.toContain('"seq":1');
      expect(sleepMock).not.toHaveBeenCalled();
    } finally {
      rejectWrites = false;
      process.stdout.emit("drain");
      expect(await running).toBe(stopped);
    }
    expect(text()).toBe('{"seq":0}\n{"seq":1}\n');
  });

  it("streams a large record across polls without breaking UTF-8 or dropping its prefix", async () => {
    const record = JSON.stringify({ text: "é".repeat(700_000) });
    const bytes = Buffer.from(record);
    fs.writeFileSync(file, bytes.subarray(0, 600_001));
    sleepMock.mockImplementationOnce(async () => {
      fs.appendFileSync(file, Buffer.concat([bytes.subarray(600_001), Buffer.from("\n")]));
    });
    const read = vi.spyOn(fs, "readSync");
    await expect(command("tail", "--since", "0")).rejects.toBe(stopped);
    expect(Buffer.concat(output)).toEqual(Buffer.concat([bytes, Buffer.from("\n")]));
    expect(read.mock.calls.every(([, buffer]) => buffer.byteLength <= 64 * 1024)).toBe(true);
  });

  it("keeps latency record selection, envelopes, malformed JSON and final EOF semantics", async () => {
    fs.writeFileSync(
      file,
      [
        '{"metadata":{"lastTurnLatencyMs":900}}',
        "",
        '{"call":{"metadata":{"lastTurnLatencyMs":100,"lastTurnListenWaitMs":20}}}',
        "invalid JSON",
        "null",
        '{"metadata":{"lastTurnLatencyMs":300,"lastTurnLatencyMs":200}}',
      ].join("\n"),
    );
    await command("latency", "--last", "4");
    expect(JSON.parse(text())).toMatchObject({
      recordsScanned: 2,
      turnLatency: { count: 2, minMs: 100, maxMs: 200, avgMs: 150 },
      listenWait: { count: 1, avgMs: 20 },
    });
  });

  it("closes the active descriptor and stops when blocked stdout fails", async () => {
    fs.writeFileSync(file, '{"seq":0}\n');
    const drainListeners = process.stdout.listenerCount("drain");
    const blocked = createDeferred<void>();
    const failed = new Error("output pipe failed");
    stdout.mockImplementation(() => {
      blocked.resolve();
      return false;
    });
    const open = vi.spyOn(fs, "openSync");
    const running = command("tail", "--since", "1").catch((error: unknown) => error);
    await blocked.promise;
    const index = open.mock.calls.findIndex(([target]) => target === file);
    const opened = open.mock.results[index];
    if (opened?.type !== "return") {
      throw new Error("diagnostic command did not open its log");
    }
    const fd = opened.value;
    expect(fs.fstatSync(fd).isFile()).toBe(true);
    // The OS can reuse fd before the command continuation resumes; observe the real close.
    const close = vi.spyOn(fs, "closeSync");
    process.stdout.emit("error", failed);
    expect(await running).toBe(failed);
    expect(close).toHaveBeenCalledExactlyOnceWith(fd);
    expect(close).toHaveReturnedWith(undefined);
    expect(sleepMock).not.toHaveBeenCalled();
    expect(process.stdout.listenerCount("drain")).toBe(drainListeners);
  });

  it("deduplicates retained SQLite snapshots without retaining retired history forever", async () => {
    file = path.join(workspace.dir, "calls.jsonl");
    const first = { callId: "first", state: "completed" };
    const second = { callId: "second", state: "completed" };
    historyMock
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([first, second])
      .mockResolvedValueOnce([second])
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([first]);
    sleepMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    await expect(command("tail", "--since", "1")).rejects.toBe(stopped);
    expect(
      text()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([first, second, first]);
  });
});
