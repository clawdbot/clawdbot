import { beforeEach, describe, expect, it, vi } from "vitest";
import { testing } from "./stage-sandbox-media.test-support.js";

const SCP_STDERR_TAIL_CHARS = 16_384;

const hasUnpairedUtf16Surrogate = (text: string): boolean =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

const { runCommandWithTimeoutMock } = vi.hoisted(() => ({
  runCommandWithTimeoutMock: vi.fn(),
}));

vi.mock("../../process/exec.js", () => ({
  runCommandWithTimeout: runCommandWithTimeoutMock,
}));

describe("scpFile", () => {
  beforeEach(() => {
    runCommandWithTimeoutMock.mockReset();
  });

  it("runs scp through the canonical bounded wrapper", async () => {
    runCommandWithTimeoutMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    await expect(testing.scpFile("host", "/remote/path", "/local/path")).resolves.toBeUndefined();
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
      [
        "scp",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "--",
        "host:/remote/path",
        "/local/path",
      ],
      { maxOutputBytes: { stdout: 1, stderr: SCP_STDERR_TAIL_CHARS * 4 } },
    );
  });

  it("surfaces UTF-16 safe scp stderr when transfer fails with emoji at tail boundary", async () => {
    // Place the retained tail window on the emoji's low surrogate so raw slicing
    // would keep a lone surrogate half before the thrown error is built.
    const lowSurrogateTailStart = 100;
    const padding = "n".repeat(lowSurrogateTailStart - 1);
    const recent = "🤖" + "n".repeat(SCP_STDERR_TAIL_CHARS - 5) + "fail";
    runCommandWithTimeoutMock.mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: `${padding}${recent}`,
    });

    let message = "";
    try {
      await testing.scpFile("host", "/remote/path", "/local/path");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/^scp failed \(1\):/);
    expect(message).toContain("fail");
    expect(message).not.toContain("🤖");
    expect(hasUnpairedUtf16Surrogate(message)).toBe(false);
  });

  it("preserves wrapper execution errors", async () => {
    const spawnError = new Error("spawn failed");
    runCommandWithTimeoutMock.mockRejectedValue(spawnError);

    await expect(testing.scpFile("host", "/remote/path", "/local/path")).rejects.toBe(spawnError);
  });
});
