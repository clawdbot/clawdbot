import { describe, expect, it } from "vitest";
import { resolveExecDetail } from "./tool-display-exec.js";
import { formatToolDetail, resolveToolDisplay } from "./tool-display.js";

describe("compactRawCommand middle truncation", () => {
  it("preserves start and end of long commands", () => {
    const longCommand =
      "/opt/custom/bin/my-processor --input /data/warehouse/2024/q1/transactions/raw/batch_001.csv --output /data/warehouse/2024/q1/transactions/processed/batch_001_clean.csv";
    const result = resolveExecDetail({ command: longCommand });
    expect(result).toContain("/opt/custom/bin/my-processor");
    expect(result).toContain("batch_001_clean.csv");
    expect(result).toContain("…");
    expect(result).not.toMatch(/…$/);
  });

  it("does not truncate short commands", () => {
    expect(resolveExecDetail({ command: "/opt/custom/bin/my-tool --version" })).toBe(
      "/opt/custom/bin/my-tool --version",
    );
  });

  it("redacts credential-like tails before middle truncation", () => {
    const longCommand =
      "/opt/custom/bin/deploy --region us-east-1 --token sk-proj-ABCDEFGHIJKLMNOP1234567890abcdefghij --output /data/results/deploy-output.json";
    expect(resolveExecDetail({ command: longCommand })).not.toContain(
      "ABCDEFGHIJKLMNOP1234567890abcdefghij",
    );
  });

  it("uses the canonical tool payload redactor before compacting raw commands", () => {
    const longCommand =
      "/opt/custom/bin/deploy --aws-key AKIDABCDEFGHIJKLMNOP1234567890 --output /data/results/deploy-output.json";
    const result = resolveExecDetail({ command: longCommand });
    expect(result).not.toContain("AKIDABCDEFGHIJKLMNOP1234567890");
    expect(result).toContain("AKIDAB…7890");
  });

  it("does not split a surrogate pair when the head boundary lands on an emoji", () => {
    const emoji = String.fromCodePoint(0x1f600);
    const longCommand = `/opt/custom/bin/run ${"a".repeat(38)}${emoji}${"b".repeat(80)}`;
    const result = resolveExecDetail({ command: longCommand });
    expect(result).toBeDefined();
    expect(result).not.toContain(emoji);
    expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(result).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(result).toContain("/opt/custom/bin/run");
    expect(result).toContain("…");
    expect(result).toMatch(/b{4}$/);
  });
});

describe("coerceDisplayValue middle truncation", () => {
  it("preserves start and end of long string values", () => {
    const longPath =
      "/usr/local/share/very/deeply/nested/directory/structure/" +
      "a".repeat(150) +
      "/important-file.txt";
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "sessions_spawn",
        args: { task: longPath },
      }),
    );
    expect(detail).toContain("/usr/local/share/");
    expect(detail).toContain("important-file.txt");
    expect(detail).toContain("…");
  });

  it("does not truncate short string values", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "sessions_spawn",
        args: { task: "short-task-name" },
      }),
    );
    expect(detail).toBe("short-task-name");
    expect(detail).not.toContain("…");
  });

  it("redacts credential-like values in long generic string details", () => {
    const longValue =
      "Deploying service to production cluster with auth ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop and " +
      "x".repeat(200) +
      " final-step";
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "sessions_spawn",
        args: { task: longValue },
      }),
    );
    expect(detail).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop");
  });

  it("uses the canonical tool payload redactor before compacting string details", () => {
    const longValue =
      "Deploying with AWS key AKIDABCDEFGHIJKLMNOP1234567890 and " +
      "x".repeat(200) +
      " final-step";
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "sessions_spawn",
        args: { task: longValue },
      }),
    );
    expect(detail).not.toContain("AKIDABCDEFGHIJKLMNOP1234567890");
    expect(detail).toContain("AKIDAB…7890");
  });
});
