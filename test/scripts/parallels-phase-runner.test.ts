// Parallels Phase Runner tests cover bounded in-memory phase log tails.
import { afterEach, expect, it, vi } from "vitest";
import { PhaseRunner } from "../../scripts/e2e/parallels/phase-runner.ts";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const tempRoots: string[] = [];

function makeTempRoot() {
  return makeTempDir(tempRoots, "openclaw-parallels-phase-runner-");
}

afterEach(() => {
  cleanupTempDirs(tempRoots);
  vi.restoreAllMocks();
});

async function captureFailedPhaseTail(runner: PhaseRunner, text: string): Promise<string> {
  const written: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  await expect(
    runner.phase("utf8-tail", 60, () => {
      runner.append(text);
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  return written.join("");
}

it("keeps the truncated phase tail UTF-8 safe when the byte cut splits a character", async () => {
  // 134 bytes total; the retained window starts one byte into the 4-byte
  // emoji, so a byte-naive decode would emit replacement characters.
  const tail = await captureFailedPhaseTail(
    new PhaseRunner(makeTempRoot(), 128),
    `${"x".repeat(50)}😀${"y".repeat(79)}`,
  );

  expect(tail).toContain("[phase log tail truncated to last 128 bytes]");
  expect(tail).not.toContain("�");
  expect(tail).toContain("y".repeat(79));
});
