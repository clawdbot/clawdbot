import { describe, expect, it } from "vitest";
import { execFileUtf8Tail } from "./logs-cli.runtime.js";

describe("execFileUtf8Tail", () => {
  it("replaces the ambient environment when an explicit environment is supplied", async () => {
    process.env.OPENCLAW_LOG_ENV_LEAK_TEST = "ambient";
    try {
      await expect(
        execFileUtf8Tail(
          process.execPath,
          ["-e", "process.stdout.write(process.env.OPENCLAW_LOG_ENV_LEAK_TEST ?? 'missing')"],
          { env: {}, maxBytes: 1024 },
        ),
      ).resolves.toMatchObject({ code: 0, stdout: "missing" });
    } finally {
      delete process.env.OPENCLAW_LOG_ENV_LEAK_TEST;
    }
  });

  it.each([
    { label: "two-byte", text: "¢z", maxBytes: 2, expected: "z" },
    { label: "three-byte", text: "€z", maxBytes: 3, expected: "z" },
    { label: "four-byte", text: "😀z", maxBytes: 4, expected: "z" },
    { label: "complete", text: "a¢z", maxBytes: 3, expected: "¢z" },
  ])("decodes a $label character at the stdout tail boundary", async (testCase) => {
    await expect(
      execFileUtf8Tail(
        process.execPath,
        ["-e", `process.stdout.write(${JSON.stringify(testCase.text)})`],
        { maxBytes: testCase.maxBytes },
      ),
    ).resolves.toEqual({
      code: 0,
      stderr: "",
      stdout: testCase.expected,
      truncated: true,
    });
  });

  it("keeps a bounded stderr tail for failed commands", async () => {
    const result = await execFileUtf8Tail(
      process.execPath,
      ["-e", "process.stderr.write('😀' + 'x'.repeat(64 * 1024)); process.exit(1)"],
      { maxBytes: 1024 },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("x".repeat(64 * 1024));
    expect(result.stderr).not.toContain("�");
    expect(result.truncated).toBe(false);
  });

  it("returns a soft failure when command launch fails", async () => {
    const command = `openclaw-missing-${process.pid}-${Date.now()}`;
    const result = await execFileUtf8Tail(command, [], { maxBytes: 1024 });
    expect(result).toMatchObject({ code: 1, stdout: "", truncated: false });
    expect(result.stderr).toMatch(/ENOENT|not found/i);
  });
});
