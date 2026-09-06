import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";

afterEach(() => vi.restoreAllMocks());

describe("package verification bounds", () => {
  it.each(["package", "launcher", "launcher directory"] as const)(
    "bounds the initial %s observation",
    async (entry) => {
      await withTestDir({ prefix: "openclaw-rollback-presence-bound-" }, async (base) => {
        const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
        const lstat = fs.lstat.bind(fs);
        const readdir = fs.readdir.bind(fs);
        const opendir = fs.opendir.bind(fs);
        const blocked = Promise.withResolvers<void>();
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
        const late = Promise.withResolvers<Awaited<ReturnType<typeof fs.open>>>();
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

  it("bounds a single directory before descending into its children", async () => {
    await withTestDir({ prefix: "openclaw-rollback-entry-bound-" }, async (base) => {
      const { params, packageRoot } = await createPackageSwapFixture(base);
      const directory = await fs.opendir(packageRoot);
      const child = await directory.read();
      expect(child).not.toBeNull();
      const read = vi.spyOn(directory, "read").mockResolvedValue(child);
      vi.spyOn(fs, "opendir").mockResolvedValue(directory);
      const open = vi.spyOn(fs, "open");
      const beforeActivate = vi.fn();
      const result = await swapStagedPackageInstall({ ...params, beforeActivate, timeoutMs: 5000 });
      expect(result.status).toBe("failed");
      expect(result.step.stderrTail).toContain("entry limit exceeded");
      expect(read).toHaveBeenCalledTimes(50_000);
      expect(open).not.toHaveBeenCalled();
      expect(beforeActivate).not.toHaveBeenCalled();
    });
  });
});
