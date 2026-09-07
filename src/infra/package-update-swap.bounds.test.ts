import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { swapStagedPackageInstall, type PackageUpdateTransaction } from "./package-update-swap.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";

afterEach(() => {
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
  vi.restoreAllMocks();
});

function captureReaderLogs() {
  const records: Array<Record<string, unknown>> = [];
  const capture = (line: string) => {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (record.subsystem === "update/package-integrity") {
      records.push(record);
    }
  };
  setLoggerOverride({ level: "silent", consoleLevel: "debug", consoleStyle: "json" });
  loggingState.rawConsole = { log: capture, info: capture, warn: capture, error: capture };
  return records;
}

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
      const observations = captureReaderLogs();
      const transactions: PackageUpdateTransaction[] = [];
      const result = await swapStagedPackageInstall({
        ...params,
        onTransaction: (transaction) => transactions.push(transaction),
      });
      expect(result.status).toBe("committed");
      expect(transactions).toHaveLength(1);
      expect((await transactions[0]!.rollback()).exitCode).toBe(0);
      await expect(fs.readFile(manifest, "utf8")).resolves.toHaveLength(1024 * 1024);
      const finished = observations.filter((record) => record.event === "reader-settled");
      expect(finished.map((record) => record.phase)).toEqual(["baseline", "retained", "restored"]);
      expect(new Set(finished.map((record) => record.readerId)).size).toBe(3);
      for (const record of finished) {
        expect(record).toMatchObject({ outcome: "completed", budgetMs: 30_000, pendingIo: 0 });
        expect(record.timeoutObservedAtMonotonicMs).toBeUndefined();
        expect(Number(record.elapsedMs)).toBeGreaterThan(0);
      }
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
        const observations = captureReaderLogs();
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
          const baseline = observations.filter((record) => record.phase === "baseline");
          expect(baseline).toHaveLength(2);
          const [begin, settled] = baseline;
          expect(begin).toMatchObject({ event: "reader-started", budgetMs: 40 });
          expect(settled).toMatchObject({
            event: "reader-settled",
            readerId: begin!.readerId,
            outcome: "timed-out",
            budgetMs: 40,
            deadlineClock: "wall",
          });
          // A pending close may accompany the stalled read. Neither is a joined OS operation.
          expect(Number(settled!.pendingIo)).toBeGreaterThan(0);
          expect(settled!.deadlineAtUnixMs).toBe(begin!.deadlineAtUnixMs);
          expect(settled!.elapsedMs).toBe(
            Number(settled!.settledAtMonotonicMs) - Number(begin!.startedAtMonotonicMs),
          );
          expect(Number(settled!.timeoutObservedAtMonotonicMs)).toBeLessThanOrEqual(
            Number(settled!.settledAtMonotonicMs),
          );
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

  it("preserves the primary refusal when reader diagnostics fail", async () => {
    await withTestDir({ prefix: "openclaw-rollback-diagnostics-" }, async (base) => {
      const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
      captureReaderLogs();
      const sink = vi.fn(() => {
        throw new Error("diagnostics sink failed");
      });
      loggingState.rawConsole = { log: sink, info: sink, warn: sink, error: sink };
      vi.spyOn(fs, "open").mockRejectedValue(new Error("reader unavailable"));
      const beforeActivate = vi.fn();
      const onLiveMutation = vi.fn();
      const result = await swapStagedPackageInstall({ ...params, beforeActivate, onLiveMutation });
      expect(sink).toHaveBeenCalled();
      expect(result.status).toBe("failed");
      expect(result.step.stderrTail).toContain("reader unavailable");
      expect(result.step.stderrTail).not.toContain("diagnostics sink failed");
      expect(beforeActivate).not.toHaveBeenCalled();
      expect(onLiveMutation).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"1.0.0"',
      );
      await expect(fs.readFile(launcher, "utf8")).resolves.toBe("old launcher\n");
    });
  });

  it("records a cleanup-only deadline without claiming successful reader completion", async () => {
    await withTestDir({ prefix: "openclaw-rollback-close-deadline-" }, async (base) => {
      const { params } = await createPackageSwapFixture(base);
      await fs.unlink(path.join(params.stage.layout.binDir, "openclaw"));
      const observations = captureReaderLogs();
      const release = createDeferredCore();
      let closing: Promise<void> | undefined;
      const opendir = fs.opendir.bind(fs);
      vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
        const directory = await opendir(...args);
        if (String(args[0]) === params.stage.layout.binDir) {
          const resource: { close(): Promise<void> } = directory;
          const close = resource.close.bind(resource);
          vi.spyOn(resource, "close").mockImplementation(() => {
            closing = release.promise.then(() => close());
            return closing;
          });
        }
        return directory;
      });
      try {
        const result = await swapStagedPackageInstall({ ...params, timeoutMs: 40 });
        // Preserve the existing best-effort close policy, but report its timeout.
        expect(result.status).toBe("committed");
        expect(observations.find((record) => record.event === "reader-settled")).toMatchObject({
          phase: "baseline",
          outcome: "timed-out",
          pendingIo: 1,
          timeoutObservedAtMonotonicMs: expect.any(Number),
        });
      } finally {
        release.resolve();
        await closing;
      }
    });
  });

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
