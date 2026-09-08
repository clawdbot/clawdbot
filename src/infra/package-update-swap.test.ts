import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { createRetainedPackageSwap } from "./package-update-swap.test-support.js";

describe("retained package backup retirement", () => {
  it.each([false, true])(
    "keeps the only intact backup after partial cleanup (caller verified=%s)",
    async (activationVerified) => {
      await withTestDir({ prefix: "openclaw-retained-backup-" }, async (base) => {
        const { result, transaction, packageRoot } = await createRetainedPackageSwap(base, true);
        expect(result).toMatchObject({ status: "failed", activePackageRoot: null });
        const completion = await transaction.complete({ activationVerified });
        await expect(
          fs.readFile(path.join(transaction.backupRoot, "dist", "index.js"), "utf8"),
        ).resolves.toBe("export {};\n");
        await expect(fs.stat(path.join(packageRoot, "dist", "index.js"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(completion).toMatchObject({
          exitCode: 1,
          stderrTail: expect.stringContaining(transaction.backupRoot),
        });
      });
    },
  );

  it.each(["unverified activation", "verified activation", "verified rollback"] as const)(
    "retires backups only after a proven outcome: %s",
    async (outcome) => {
      await withTestDir({ prefix: "openclaw-retained-outcome-" }, async (base) => {
        const { result, transaction, packageRoot } = await createRetainedPackageSwap(base);
        expect(result.status).toBe("committed");
        if (outcome === "verified rollback") {
          expect(await transaction.rollback()).toMatchObject({
            exitCode: 0,
            activePackageRoot: packageRoot,
          });
        }
        const completion = await transaction.complete({
          activationVerified: outcome === "verified activation",
        });
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain(`"version":"${outcome === "verified rollback" ? "1.0.0" : "2.0.0"}"`);
        if (outcome === "unverified activation") {
          await expect(fs.stat(transaction.backupRoot)).resolves.toBeDefined();
        } else {
          expect(completion).toBeUndefined();
          await expect(fs.stat(transaction.backupRoot)).rejects.toMatchObject({ code: "ENOENT" });
        }
      });
    },
  );
});
