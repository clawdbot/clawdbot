// File Transfer tests cover canonical process-wrapper failures during dir fetch.
import { afterEach, describe, expect, it, vi } from "vitest";

const { runCommandBufferedMock } = vi.hoisted(() => ({ runCommandBufferedMock: vi.fn() }));

vi.mock("openclaw/plugin-sdk/process-runtime", () => ({
  runCommandBuffered: runCommandBufferedMock,
}));

import { testing } from "./dir-fetch.js";

function commandResult(overrides: Record<string, unknown> = {}) {
  return {
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}

afterEach(() => {
  runCommandBufferedMock.mockReset();
});

describe("dir.fetch process wrapper", () => {
  it("falls back to capped tar when the optional du probe fails", async () => {
    runCommandBufferedMock.mockRejectedValueOnce(new Error("du failed"));

    await expect(testing.preflightDu("/tmp/project", 1024)).resolves.toBe(true);
    expect(runCommandBufferedMock).toHaveBeenCalledWith(
      ["du", "-sk", "/tmp/project"],
      expect.objectContaining({ discardOutput: { stderr: true } }),
    );
  });

  it("fails tar entry listing closed on wrapper errors", async () => {
    runCommandBufferedMock.mockResolvedValueOnce(
      commandResult({ code: null, termination: "error", error: new Error("listing failed") }),
    );

    await expect(testing.listTarEntries(Buffer.from("archive"))).resolves.toBeNull();
    expect(runCommandBufferedMock).toHaveBeenCalledWith(
      ["tar", "-tzf", "-"],
      expect.objectContaining({ discardOutput: { stderr: true } }),
    );
  });

  it("classifies archive output caps, timeouts, and launch errors", async () => {
    runCommandBufferedMock.mockResolvedValueOnce(
      commandResult({
        code: null,
        termination: "output-limit",
        outputLimitStream: "stdout",
      }),
    );
    await expect(testing.createTarArchive("/tmp/project", 1024)).resolves.toBe("TOO_LARGE");
    expect(runCommandBufferedMock).toHaveBeenLastCalledWith(
      expect.any(Array),
      expect.objectContaining({ discardOutput: { stderr: true } }),
    );

    runCommandBufferedMock.mockResolvedValueOnce(
      commandResult({ code: null, termination: "timeout" }),
    );
    await expect(testing.createTarArchive("/tmp/project", 1024)).resolves.toBe("TIMEOUT");

    runCommandBufferedMock.mockRejectedValueOnce(new Error("spawn failed"));
    await expect(testing.createTarArchive("/tmp/project", 1024)).resolves.toBe("ERROR");
  });
});
