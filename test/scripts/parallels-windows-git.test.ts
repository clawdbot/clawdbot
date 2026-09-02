// Parallels Windows Git tests cover host-side MinGit preparation.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

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

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  runMock.mockReset();
});

function mockMinGitDownload(params: {
  assetName: string;
  assetUrl: string;
  expectedSha256: string;
  payload: Buffer;
}): void {
  runMock.mockImplementation((command: string, args: string[]) => {
    if (command === "python3") {
      return {
        status: 0,
        stderr: "",
        stdout: `${params.assetName}\n${params.assetUrl}\nsha256:${params.expectedSha256}\n`,
      };
    }
    if (command === "curl") {
      const outputIndex = args.indexOf("-o");
      const destination = args[outputIndex + 1];
      if (!destination) {
        throw new Error("curl output path missing");
      }
      writeFileSync(destination, params.payload);
    }
    return { status: 0, stderr: "", stdout: "" };
  });
}

describe("Parallels Windows MinGit preparation", () => {
  it("bounds and verifies the host asset download", async () => {
    const assetName = "MinGit-2.55.0.5-64-bit.zip";
    const assetUrl = `https://example.test/${assetName}`;
    const targetDir = tempDirs.make("openclaw-windows-smoke-");
    const targetPath = path.join(targetDir, assetName);
    const payload = Buffer.from("verified MinGit archive");
    const expectedSha256 = createHash("sha256").update(payload).digest("hex");
    mockMinGitDownload({ assetName, assetUrl, expectedSha256, payload });

    await expect(prepareMinGitZip(targetDir)).resolves.toBe(targetPath);
    expect(runMock).toHaveBeenCalledWith(
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

  it("rejects a MinGit fallback whose bytes do not match the release digest", async () => {
    const assetName = "MinGit-2.55.0.5-arm64.zip";
    const assetUrl = `https://example.test/${assetName}`;
    const targetDir = tempDirs.make("openclaw-windows-smoke-");
    mockMinGitDownload({
      assetName,
      assetUrl,
      expectedSha256: "0".repeat(64),
      payload: Buffer.from("tampered MinGit archive"),
    });

    await expect(prepareMinGitZip(targetDir)).rejects.toThrow("MinGit SHA-256 mismatch");
  });
});
