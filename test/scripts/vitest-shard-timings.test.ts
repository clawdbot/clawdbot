import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createShardTimingSample,
  readShardTimings,
  resolveShardTimingKey,
  writeShardTimings,
} from "../../scripts/lib/vitest-shard-timings.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("scripts/lib/vitest-shard-timings.mjs", () => {
  it("uses the config path as the timing key for whole-config runs", () => {
    expect(
      resolveShardTimingKey({
        config: "test/vitest/vitest.unit-fast.config.ts",
        env: {},
        includePatterns: null,
      }),
    ).toBe("test/vitest/vitest.unit-fast.config.ts");
  });

  it("uses the CI shard name for include-pattern timing keys", () => {
    expect(
      resolveShardTimingKey({
        config: "test/vitest/vitest.auto-reply-reply.config.ts",
        env: { OPENCLAW_VITEST_SHARD_NAME: "auto-reply/reply agent dispatch" },
        includePatterns: ["src/auto-reply/reply/agent-runner.test.ts"],
      }),
    ).toBe("test/vitest/vitest.auto-reply-reply.config.ts#auto-reply-reply-agent-dispatch");
  });

  it("falls back to a stable include-pattern hash outside CI", () => {
    const first = resolveShardTimingKey({
      config: "test/vitest/vitest.auto-reply-reply.config.ts",
      env: {},
      includePatterns: ["src/auto-reply/reply/agent-runner.test.ts"],
    });
    const second = resolveShardTimingKey({
      config: "test/vitest/vitest.auto-reply-reply.config.ts",
      env: {},
      includePatterns: ["src/auto-reply/reply/agent-runner.test.ts"],
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^test\/vitest\/vitest\.auto-reply-reply\.config\.ts#include-1-/u);
  });

  it("persists include-pattern timing metadata", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-shard-timings-"));
    tempDirs.push(tempDir);
    const env = {
      OPENCLAW_TEST_PROJECTS_TIMINGS_PATH: path.join(tempDir, "timings.json"),
      OPENCLAW_VITEST_SHARD_NAME: "auto-reply-reply-agent-runner",
    };
    const sample = createShardTimingSample(
      {
        config: "test/vitest/vitest.auto-reply-reply.config.ts",
        env,
        includePatterns: ["src/auto-reply/reply/agent-runner.test.ts"],
        watchMode: false,
      },
      1234,
    );

    expect(sample).toEqual({
      baseConfig: "test/vitest/vitest.auto-reply-reply.config.ts",
      config: "test/vitest/vitest.auto-reply-reply.config.ts#auto-reply-reply-agent-runner",
      durationMs: 1234,
      includePatternCount: 1,
    });

    writeShardTimings([sample], tempDir, env);

    expect(readShardTimings(tempDir, env)).toEqual(
      new Map([
        ["test/vitest/vitest.auto-reply-reply.config.ts#auto-reply-reply-agent-runner", 1234],
      ]),
    );
    const persistedTiming = JSON.parse(
      fs.readFileSync(env.OPENCLAW_TEST_PROJECTS_TIMINGS_PATH, "utf8"),
    ).configs["test/vitest/vitest.auto-reply-reply.config.ts#auto-reply-reply-agent-runner"];
    expect(typeof persistedTiming.updatedAt).toBe("string");
    expect(persistedTiming.updatedAt.length).toBeGreaterThan(0);
    expect({ ...persistedTiming, updatedAt: "<dynamic>" }).toStrictEqual({
      averageMs: 1234,
      baseConfig: "test/vitest/vitest.auto-reply-reply.config.ts",
      includePatternCount: 1,
      lastMs: 1234,
      sampleCount: 1,
      updatedAt: "<dynamic>",
    });
  });
});
