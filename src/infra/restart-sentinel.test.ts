import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  consumeRestartSentinel,
  readRestartSentinel,
  resolveRestartSentinelPath,
  trimLogTail,
  writeRestartSentinel,
} from "./restart-sentinel.js";

describe("restart sentinel", () => {
  let prevStateDir: string | undefined;
  let tempDir: string;

  beforeEach(async () => {
    prevStateDir = process.env.CLAWDBOT_STATE_DIR;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-sentinel-"));
    process.env.CLAWDBOT_STATE_DIR = tempDir;
  });

  afterEach(async () => {
    if (prevStateDir) process.env.CLAWDBOT_STATE_DIR = prevStateDir;
    else delete process.env.CLAWDBOT_STATE_DIR;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("writes and consumes a sentinel", async () => {
    const payload = {
      kind: "update" as const,
      status: "ok" as const,
      ts: Date.now(),
      sessionKey: "agent:main:whatsapp:dm:+15555550123",
      stats: { mode: "git" },
    };
    const filePath = await writeRestartSentinel(payload);
    expect(filePath).toBe(resolveRestartSentinelPath());

    const read = await readRestartSentinel();
    expect(read?.payload.kind).toBe("update");

    const consumed = await consumeRestartSentinel();
    expect(consumed?.payload.sessionKey).toBe(payload.sessionKey);

    const empty = await readRestartSentinel();
    expect(empty).toBeNull();
  });

  it("drops invalid sentinel payloads", async () => {
    const filePath = resolveRestartSentinelPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "not-json", "utf-8");

    const read = await readRestartSentinel();
    expect(read).toBeNull();

    await expect(fs.stat(filePath)).rejects.toThrow();
  });

  it("trims log tails", () => {
    const text = "a".repeat(9000);
    const trimmed = trimLogTail(text, 8000);
    expect(trimmed?.length).toBeLessThanOrEqual(8001);
    expect(trimmed?.startsWith("…")).toBe(true);
  });
});
