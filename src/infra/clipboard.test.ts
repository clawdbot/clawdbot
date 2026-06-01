import { beforeEach, describe, expect, it, vi } from "vitest";

const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());
const isWSL2SyncMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.mock("./wsl.js", () => ({
  isWSL2Sync: isWSL2SyncMock,
}));

const { copyToClipboard } = await import("./clipboard.js");

describe("copyToClipboard", () => {
  beforeEach(() => {
    runCommandWithTimeoutMock.mockReset();
    isWSL2SyncMock.mockReturnValue(false);
  });

  it("returns true on the first successful clipboard command", async () => {
    runCommandWithTimeoutMock.mockResolvedValueOnce({ code: 0, killed: false });

    await expect(copyToClipboard("hello")).resolves.toBe(true);
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(["pbcopy"], {
      timeoutMs: 3000,
      input: "hello",
    });
    expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it("falls through failed attempts until a later command succeeds", async () => {
    runCommandWithTimeoutMock
      .mockRejectedValueOnce(new Error("missing pbcopy"))
      .mockResolvedValueOnce({ code: 1, killed: false })
      .mockResolvedValueOnce({ code: 0, killed: false });

    await expect(copyToClipboard("hello")).resolves.toBe(true);
    expect(runCommandWithTimeoutMock.mock.calls.map((call) => call[0])).toEqual([
      ["pbcopy"],
      ["xclip", "-selection", "clipboard"],
      ["wl-copy"],
    ]);
  });

  it("uses a startup-free WSL2 shell bridge for clip.exe without putting the value in argv", async () => {
    isWSL2SyncMock.mockReturnValue(true);
    runCommandWithTimeoutMock.mockResolvedValueOnce({ code: 0, killed: false });

    const tokenUrl = "http://127.0.0.1:18789/#token=secret-token";
    await expect(copyToClipboard(tokenUrl)).resolves.toBe(true);

    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
      ["/bin/sh", "-c", "exec /mnt/c/Windows/System32/clip.exe"],
      {
        timeoutMs: 3000,
        input: tokenUrl,
      },
    );
    const invokedArgv = runCommandWithTimeoutMock.mock.calls[0]?.[0] as string[];
    expect(invokedArgv.join("\0")).not.toContain("secret-token");
    expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it("does not prepend the WSL2 bridge outside WSL2", async () => {
    runCommandWithTimeoutMock
      .mockRejectedValueOnce(new Error("missing pbcopy"))
      .mockResolvedValueOnce({ code: 0, killed: true })
      .mockRejectedValueOnce(new Error("missing wl-copy"))
      .mockResolvedValueOnce({ code: 0, killed: false });

    await expect(copyToClipboard("hello")).resolves.toBe(true);
    expect(runCommandWithTimeoutMock.mock.calls.map((call) => call[0])).toEqual([
      ["pbcopy"],
      ["xclip", "-selection", "clipboard"],
      ["wl-copy"],
      ["clip.exe"],
    ]);
  });

  it("returns false when every clipboard backend fails or is killed", async () => {
    runCommandWithTimeoutMock
      .mockResolvedValueOnce({ code: 0, killed: true })
      .mockRejectedValueOnce(new Error("missing xclip"))
      .mockResolvedValueOnce({ code: 1, killed: false })
      .mockRejectedValueOnce(new Error("missing clip.exe"))
      .mockResolvedValueOnce({ code: 2, killed: false });

    await expect(copyToClipboard("hello")).resolves.toBe(false);
    expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(5);
  });
});
