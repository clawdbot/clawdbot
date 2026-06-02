import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withProofTempRoot } from "../../scripts/repro/limit-edge-case-live-proof.mjs";

describe("limit-edge-case live proof", () => {
  it("cleans the generated session-log temp root", async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "openclaw-limit-proof-test-"));
    try {
      const originalTmpdir = process.env.TMPDIR;
      process.env.TMPDIR = tempRoot;
      let proofRoot = "";
      try {
        await withProofTempRoot(async (root) => {
          proofRoot = root;
          writeFileSync(path.join(root, "s.jsonl"), "{}\n");
          expect(existsSync(root)).toBe(true);
        });
      } finally {
        if (originalTmpdir === undefined) {
          delete process.env.TMPDIR;
        } else {
          process.env.TMPDIR = originalTmpdir;
        }
      }

      expect(proofRoot).not.toBe("");
      expect(existsSync(proofRoot)).toBe(false);
      expect(readdirSync(tempRoot).filter((entry) => entry.startsWith("openclaw-proof-"))).toEqual(
        [],
      );
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });
});
