import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHomeCore } from "./temp-home.js";

describe("shared temp-home root acquisition", () => {
  it("shares a failed acquisition, then recovers on the next explicit call", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "sdk-home-acquisition-"));
    const missingParent = path.join(parent, "missing");
    const prefix = path.join(path.basename(parent), "missing", "shared-");
    const options = { prefix, skipSessionCleanup: true };
    const unexpectedCallback = async () => {
      throw new Error("callback must not run when root acquisition fails");
    };
    try {
      const failures = await Promise.allSettled([
        withTempHomeCore(unexpectedCallback, options),
        withTempHomeCore(unexpectedCallback, options),
        withTempHomeCore(unexpectedCallback, options),
      ]);
      const errors = failures.map((result) => {
        expect(result.status).toBe("rejected");
        return result.status === "rejected" ? result.reason : undefined;
      });
      expect(errors[0]).toMatchObject({ code: "ENOENT" });
      expect(errors.every((error) => error === errors[0])).toBe(true);
      expect(await fs.readdir(parent)).toEqual([]);

      await fs.mkdir(missingParent);
      const first = await withTempHomeCore(
        async (home) => {
          await fs.writeFile(path.join(home, "retained.txt"), "keep");
          return home;
        },
        { ...options, skipHomeCleanup: true },
      );
      const second = await withTempHomeCore(async (home) => home, options);
      const third = await withTempHomeCore(async (home) => home, options);
      expect(path.dirname(second)).toBe(path.dirname(first));
      expect(path.dirname(third)).toBe(path.dirname(first));
      expect([first, second, third].map((home) => path.basename(home))).toEqual([
        "case-0",
        "case-1",
        "case-2",
      ]);
      expect(await fs.readdir(path.dirname(first))).toEqual([path.basename(first)]);
      expect(await fs.readFile(path.join(first, "retained.txt"), "utf8")).toBe("keep");
      const independent = await withTempHomeCore(async (home) => home, {
        prefix: path.join(path.basename(parent), "independent-"),
        skipSessionCleanup: true,
      });
      expect(path.dirname(independent)).not.toBe(path.dirname(first));
      expect(await fs.readdir(path.dirname(independent))).toEqual([]);
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
});
