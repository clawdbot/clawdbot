import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { swapStagedPackageInstall, type PackageUpdateTransaction } from "./package-update-swap.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";

afterEach(() => vi.restoreAllMocks());

describe("package verification bounds", () => {
  it.each([1024 * 1024 + 1, 1024 * 1024 * 1024 + 1])(
    "rejects manifest growth to %i bytes without attempting an oversized metadata allocation",
    async (size) => {
      await withTestDir({ prefix: "openclaw-rollback-metadata-bound-" }, async (base) => {
        const { params, packageRoot } = await createPackageSwapFixture(base);
        const manifest = path.join(packageRoot, "package.json");
        const open = fs.open.bind(fs);
        let manifestOpens = 0;
        let grew = false;
        let oversizedRead = false;
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await open(...args);
          if (String(args[0]) !== manifest) {
            return handle;
          }
          if (++manifestOpens === 1) {
            const close = handle.close.bind(handle);
            vi.spyOn(handle, "close").mockImplementation(async () => {
              await close();
              await fs.truncate(manifest, size);
              grew = true;
            });
          } else {
            // Intercept either read path before buffering an oversized sparse file.
            const rejectOversizedRead = async () => {
              oversizedRead = true;
              throw new Error("oversized metadata allocation intercepted");
            };
            vi.spyOn(handle, "readFile").mockImplementation(rejectOversizedRead);
            vi.spyOn(handle, "read").mockImplementation(rejectOversizedRead);
          }
          return handle;
        });
        const beforeActivate = vi.fn();
        const onLiveMutation = vi.fn();
        const result = await swapStagedPackageInstall({
          ...params,
          beforeActivate,
          onLiveMutation,
        });
        expect(grew).toBe(true);
        expect(result.status).toBe("failed");
        expect(oversizedRead).toBe(false);
        expect(beforeActivate).not.toHaveBeenCalled();
        expect(onLiveMutation).not.toHaveBeenCalled();
      });
    },
  );

  it("accepts a valid manifest at the metadata byte limit", async () => {
    await withTestDir({ prefix: "openclaw-rollback-metadata-valid-" }, async (base) => {
      const { params, packageRoot } = await createPackageSwapFixture(base);
      const manifest = path.join(packageRoot, "package.json");
      const contents = await fs.readFile(manifest, "utf8");
      await fs.writeFile(manifest, contents.padEnd(1024 * 1024, " "));
      const transactions: PackageUpdateTransaction[] = [];
      const result = await swapStagedPackageInstall({
        ...params,
        onTransaction: (transaction) => transactions.push(transaction),
      });
      expect(result.status).toBe("committed");
      expect(transactions).toHaveLength(1);
      expect((await transactions[0]!.rollback()).exitCode).toBe(0);
      await expect(fs.readFile(manifest, "utf8")).resolves.toHaveLength(1024 * 1024);
    });
  });

  it.each(["package", "launcher", "launcher directory"] as const)(
    "bounds the initial %s observation",
    async (entry) => {
      await withTestDir({ prefix: "openclaw-rollback-presence-bound-" }, async (base) => {
        const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
        const lstat = fs.lstat.bind(fs);
        const readdir = fs.readdir.bind(fs);
        const opendir = fs.opendir.bind(fs);
        const blocked = createDeferredCore();
        const target =
          entry === "package"
            ? packageRoot
            : entry === "launcher"
              ? launcher
              : params.stage.layout.binDir;
        let entered = false;
        const block = async (file: unknown) => {
          if (!entered && String(file) === target) {
            entered = true;
            await blocked.promise;
          }
        };
        vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
          await block(args[0]);
          return lstat(...args);
        });
        vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
          await block(args[0]);
          return readdir(...args);
        });
        vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
          await block(args[0]);
          return opendir(...args);
        });
        const beforeActivate = vi.fn();
        const onLiveMutation = vi.fn();
        const update = swapStagedPackageInstall({
          ...params,
          beforeActivate,
          onLiveMutation,
          timeoutMs: 200,
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            update,
            new Promise<"pending">((resolve) => {
              timer = setTimeout(() => resolve("pending"), 750);
            }),
          ]);
          expect(entered).toBe(true);
          expect(result).toMatchObject({ status: "failed" });
          expect(beforeActivate).not.toHaveBeenCalled();
          expect(onLiveMutation).not.toHaveBeenCalled();
        } finally {
          clearTimeout(timer);
          blocked.resolve();
          await update;
        }
      });
    },
  );

  it.each(["open", "read"] as const)(
    "returns after a stalled %s without continuing the walk",
    async (operation) => {
      await withTestDir({ prefix: "openclaw-rollback-deadline-" }, async (base) => {
        const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
        const realOpen = fs.open.bind(fs);
        const late = createDeferredCore<Awaited<ReturnType<typeof fs.open>>>();
        const handle = await realOpen(path.join(packageRoot, "dist", "index.js"), "r");
        const close = vi.spyOn(handle, "close");
        const read = vi.spyOn(handle, "read");
        const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          if (operation === "open") {
            return late.promise;
          }
          const actual = await realOpen(...args);
          vi.spyOn(actual, "read").mockImplementation(() => new Promise(() => {}));
          return actual;
        });
        const beforeActivate = vi.fn();
        const onLiveMutation = vi.fn();
        const started = Date.now();
        try {
          const result = await swapStagedPackageInstall({
            ...params,
            beforeActivate,
            onLiveMutation,
            timeoutMs: 40,
          });
          expect(result.status).toBe("failed");
          expect(result.step.stderrTail).toContain("timed out");
          expect(Date.now() - started).toBeLessThan(2000);
          expect(beforeActivate).not.toHaveBeenCalled();
          expect(onLiveMutation).not.toHaveBeenCalled();
          expect(open).toHaveBeenCalledTimes(1);
          if (operation === "open") {
            late.resolve(handle);
            await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
            expect(read).not.toHaveBeenCalled();
          }
          await expect(
            fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
          ).resolves.toContain('"version":"1.0.0"');
          await expect(fs.readFile(launcher, "utf8")).resolves.toBe("old launcher\n");
        } finally {
          late.resolve(handle);
          await handle.close();
        }
      });
    },
  );

  it.each([
    { shape: "single directory", width: 50_000 },
    { shape: "nested directories", width: 30_000 },
  ])("bounds the whole-tree inventory across $shape", async ({ width }) => {
    await withTestDir({ prefix: "openclaw-rollback-entry-bound-" }, async (base) => {
      const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
      const nested = path.join(packageRoot, "dist");
      const rootChild = (await fs.readdir(packageRoot, { withFileTypes: true })).find(
        (entry) => entry.name === "dist",
      )!;
      const [nestedChild] = await fs.readdir(nested, { withFileTypes: true });
      const opendir = fs.opendir.bind(fs);
      let discovered = 0;
      vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
        const directory = await opendir(...args);
        if (![packageRoot, nested].includes(String(args[0]))) {
          return directory;
        }
        const child = String(args[0]) === packageRoot ? rootChild : nestedChild!;
        // Model wide inventories without allocating their contents on disk.
        const promiseReader: { read(): Promise<typeof child | null> } = directory;
        let returned = 0;
        vi.spyOn(promiseReader, "read").mockImplementation(async () => {
          if (returned++ >= width) {
            return null;
          }
          discovered++;
          return child;
        });
        return directory;
      });
      const open = vi.spyOn(fs, "open").mockRejectedValue(new Error("unexpected file read"));
      const beforeActivate = vi.fn();
      const onLiveMutation = vi.fn();
      const result = await swapStagedPackageInstall({
        ...params,
        beforeActivate,
        onLiveMutation,
        timeoutMs: 5000,
      });
      expect(result.status).toBe("failed");
      expect(beforeActivate).not.toHaveBeenCalled();
      expect(onLiveMutation).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"1.0.0"',
      );
      await expect(fs.readFile(launcher, "utf8")).resolves.toBe("old launcher\n");
      // Includes one overflow entry; the root itself consumes the other slot.
      expect(discovered).toBeLessThanOrEqual(50_000);
      expect(result.step.stderrTail).toContain("entry limit exceeded");
      expect(open).not.toHaveBeenCalled();
    });
  });
});
