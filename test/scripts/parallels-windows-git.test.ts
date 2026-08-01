// Parallels Windows Git tests cover host-side MinGit preparation.
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const { runMock } = vi.hoisted(() => ({
  runMock: vi.fn(),
}));

vi.mock("../../scripts/e2e/parallels/host-command.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../scripts/e2e/parallels/host-command.ts")>();
  return {
    ...actual,
    run: runMock,
    say: vi.fn(),
  };
});

import { prepareMinGitZip } from "../../scripts/e2e/parallels/windows-git.ts";

describe("Parallels Windows MinGit preparation", () => {
  it("bounds the host asset download across connections, transfers, and retries", async () => {
    const assetName = "MinGit-2.55.0.3-64-bit.zip";
    const assetUrl = `https://example.test/${assetName}`;
    const targetDir = path.join("tmp", "windows-smoke");
    const targetPath = path.join(targetDir, assetName);
    runMock.mockImplementation((command: string) => ({
      status: 0,
      stderr: "",
      stdout: command === "python3" ? `${assetName}\n${assetUrl}\n` : "",
    }));

    await expect(prepareMinGitZip(targetDir)).resolves.toBe(targetPath);
    expect(runMock).toHaveBeenNthCalledWith(
      2,
      "curl",
      [
        "--retry",
        "5",
        "--retry-delay",
        "3",
        "--retry-all-errors",
        "--connect-timeout",
        "10",
        "--max-time",
        "120",
        "--retry-max-time",
        "120",
        "-fsSL",
        assetUrl,
        "-o",
        targetPath,
      ],
      { timeoutMs: 270_000 },
    );
  });
});
