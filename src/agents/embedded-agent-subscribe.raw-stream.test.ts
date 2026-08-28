import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { appendRawStream } from "./embedded-agent-subscribe.raw-stream.js";

describe("appendRawStream", () => {
  let tmpDir: string;
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-raw-stream-test-"));
  });

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_RAW_STREAM", "true");
    process.on("unhandledRejection", onUnhandledRejection);
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandledRejection);
    unhandledRejections.length = 0;
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function drainAsyncWrites(): Promise<void> {
    await Promise.resolve();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }

  it("contains a real rejected append without leaking an unhandled rejection", async () => {
    const directoryTarget = path.join(tmpDir, "directory-target");
    fs.mkdirSync(directoryTarget);
    vi.stubEnv("OPENCLAW_RAW_STREAM_PATH", directoryTarget);

    expect(() => appendRawStream({ event: "test", ts: 1 })).not.toThrow();
    await drainAsyncWrites();

    expect(unhandledRejections).toHaveLength(0);
  });

  it("appends exact JSONL through the real dependency", async () => {
    const rawStreamPath = path.join(tmpDir, "raw.jsonl");
    vi.stubEnv("OPENCLAW_RAW_STREAM_PATH", rawStreamPath);

    appendRawStream({ event: "test", ts: 1 });
    // The async writer creates the file before its append completes.
    await vi.waitFor(() => {
      expect(fs.readFileSync(rawStreamPath, "utf8")).toBe('{"event":"test","ts":1}\n');
    });
    expect(unhandledRejections).toHaveLength(0);
  });

  it("does nothing when raw streaming is disabled", async () => {
    const rawStreamPath = path.join(tmpDir, "disabled.jsonl");
    vi.stubEnv("OPENCLAW_RAW_STREAM", "");
    vi.stubEnv("OPENCLAW_RAW_STREAM_PATH", rawStreamPath);

    appendRawStream({ event: "test", ts: 1 });
    await drainAsyncWrites();

    expect(fs.existsSync(rawStreamPath)).toBe(false);
    expect(unhandledRejections).toHaveLength(0);
  });

  it("contains synchronous JSON serialization failures", () => {
    const rawStreamPath = path.join(tmpDir, "cyclic.jsonl");
    const payload: Record<string, unknown> = {};
    payload.self = payload;
    vi.stubEnv("OPENCLAW_RAW_STREAM_PATH", rawStreamPath);

    expect(() => appendRawStream(payload)).not.toThrow();
    expect(fs.existsSync(rawStreamPath)).toBe(false);
    expect(unhandledRejections).toHaveLength(0);
  });
});
