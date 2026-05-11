import { describe, expect, it } from "vitest";
import {
  BOUNDARY_CHECKS,
  formatCommand,
  parseShardSpec,
  resolveConcurrency,
  runChecks,
  selectChecksForShard,
} from "../../scripts/run-additional-boundary-checks.mjs";

function createOutputBuffer() {
  const chunks: string[] = [];
  return {
    output: {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    },
    text: () => chunks.join(""),
  };
}

describe("run-additional-boundary-checks", () => {
  it("runs prompt snapshot drift checks in CI", () => {
    expect(BOUNDARY_CHECKS).toContainEqual({
      label: "prompt:snapshots:check",
      command: "pnpm",
      args: ["prompt:snapshots:check"],
    });
  });

  it("normalizes concurrency input", () => {
    expect(resolveConcurrency("6")).toBe(6);
    expect(resolveConcurrency("0")).toBe(4);
    expect(resolveConcurrency("nope", 2)).toBe(2);
  });

  it("formats command display text", () => {
    expect(formatCommand({ command: "pnpm", args: ["run", "lint:core"] })).toBe(
      "pnpm run lint:core",
    );
  });

  it("parses and applies CI shard specs", () => {
    expect(parseShardSpec("2/4")).toEqual({ count: 4, index: 1, label: "2/4" });
    expect(selectChecksForShard(BOUNDARY_CHECKS, "1/4")).toEqual(
      BOUNDARY_CHECKS.filter((_check, index) => index % 4 === 0),
    );
    const shardedLabels = [1, 2, 3, 4].flatMap((index) =>
      selectChecksForShard(BOUNDARY_CHECKS, `${index}/4`).map((check) => check.label),
    );
    expect(shardedLabels.toSorted((a, b) => a.localeCompare(b))).toEqual(
      BOUNDARY_CHECKS.map((check) => check.label).toSorted((a, b) => a.localeCompare(b)),
    );
    expect(new Set(shardedLabels).size).toBe(BOUNDARY_CHECKS.length);
    expect(() => parseShardSpec("5/4")).toThrow("Invalid shard spec");
  });

  it("keeps the raw HTTP/2 import guard in source boundary checks", () => {
    expect(BOUNDARY_CHECKS).toContainEqual({
      label: "lint:tmp:no-raw-http2-imports",
      command: "pnpm",
      args: ["run", "lint:tmp:no-raw-http2-imports"],
    });
  });

  it("buffers grouped output and reports aggregate failures", async () => {
    const buffer = createOutputBuffer();
    const failures = await runChecks(
      [
        {
          label: "passes",
          command: process.execPath,
          args: ["-e", "console.log('ok-out')"],
        },
        {
          label: "fails",
          command: process.execPath,
          args: ["-e", "console.error('bad-out'); process.exit(7)"],
        },
      ],
      { concurrency: 2, output: buffer.output },
    );

    const text = buffer.text();
    expect(failures).toBe(1);
    expect(text).toContain("::group::passes");
    expect(text).toContain("ok-out");
    expect(text).toContain("[ok] passes in ");
    expect(text).toContain("::group::fails");
    expect(text).toContain("bad-out");
    expect(text).toContain("::error title=fails failed::fails failed (exit 7)");
    expect(text).toContain("Additional boundary check timings:");
  });
});
