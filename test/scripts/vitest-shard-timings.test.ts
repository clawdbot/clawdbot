// Vitest Shard Timings tests cover vitest shard timings script behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveShardTimingKey } from "../../scripts/lib/vitest-shard-metadata.mts";
import {
  createShardTimingSample,
  readShardTimings,
  writeShardTimings,
} from "../../scripts/lib/vitest-shard-timings.mts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("scripts/lib/vitest-shard-timings.mts", () => {
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

  it.each([
    ["src/b.test.ts", "src/a.test.ts"],
    ["src/ä.test.ts", "src/z.test.ts", "src/A.test.ts"],
  ])("reuses timing history for reordered selections: %s", (...patterns) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-shard-timings-"));
    tempDirs.push(tempDir);
    const env = { OPENCLAW_TEST_PROJECTS_TIMINGS_PATH: path.join(tempDir, "timings.json") };
    const config = "test/vitest/vitest.unit-fast.config.ts";
    const includePatterns = Object.freeze(patterns);
    const sample = createShardTimingSample({ config, env, includePatterns }, 1000)!;
    writeShardTimings([sample], tempDir, env);
    const reordered = createShardTimingSample(
      { config, env, includePatterns: includePatterns.toReversed() },
      2000,
    )!;
    writeShardTimings([reordered], tempDir, env);

    expect(readShardTimings(tempDir, env)).toEqual(new Map([[sample.config, 1300]]));
    const { configs } = JSON.parse(
      fs.readFileSync(env.OPENCLAW_TEST_PROJECTS_TIMINGS_PATH, "utf8"),
    );
    expect(configs[sample.config].sampleCount).toBe(2);
    expect(
      resolveShardTimingKey({
        config,
        env,
        includePatterns: [...includePatterns, "src/c.test.ts"],
      }),
    ).not.toBe(sample.config);
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
