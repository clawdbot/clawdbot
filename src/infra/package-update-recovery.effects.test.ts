import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  createPackageRecoveryTransaction,
  reopenPackageUpdateTransaction,
  type PackageRecoveryEffect,
  type PackageRecoveryHooks,
  type PackageTransactionDescriptor,
} from "./package-update-recovery.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import { createRootRunner, writePackageRoot } from "./package-update-steps.test-support.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";
import {
  createPackageSwapFixture,
  createRetainedPackageSwap,
} from "./package-update-swap.test-support.js";

it("does not compensate after Recovery revocation during activation", async () => {
  await withTestDir({ prefix: "openclaw-package-revocation-" }, async (base) => {
    const f = await createPackageSwapFixture(base);
    let revoked = false;
    let backup: string | undefined;
    let descriptor: PackageTransactionDescriptor | undefined;
    let pendingEffect: PackageRecoveryEffect | undefined;
    const staleRenames: string[] = [];
    const assertCurrent = () => {
      if (revoked) {
        throw new Error("Recovery owner revoked");
      }
    };
    const hooks: PackageRecoveryHooks = {
      transactionId: randomUUID(),
      persistDescriptor: async (observed) => {
        descriptor = observed.descriptor;
        backup = observed.descriptor.backupRoot;
        return { assertCurrent };
      },
      beforeEffect: async (effect) => {
        pendingEffect = effect;
        return { assertCurrent, afterEffect: async () => {} };
      },
    };
    const original = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (revoked) {
        staleRenames.push(`${String(source)} -> ${String(destination)}`);
      }
      await original(source, destination);
      if (source === f.packageRoot) {
        revoked = true;
      }
    });
    try {
      expect(await swapStagedPackageInstall({ ...f.params, recovery: hooks })).toMatchObject({
        status: "failed",
        activePackageRoot: null,
        step: { stderrTail: expect.stringContaining("Recovery owner revoked") },
      });
    } finally {
      rename.mockRestore();
    }
    expect(staleRenames).toEqual([]);
    await expect(fs.readFile(path.join(backup!, "package.json"), "utf8")).resolves.toContain(
      '"version":"1.0.0"',
    );
    await expect(fs.readFile(f.launcher, "utf8")).resolves.toBe("old launcher\n");
    const reopened = await reopenPackageUpdateTransaction({
      descriptor,
      pendingEffect,
      expectedLiveRoot: f.packageRoot,
      expectedBinDir: path.dirname(f.launcher),
      expectedTransactionId: hooks.transactionId,
      hooks: {
        ...hooks,
        beforeEffect: async () => ({ assertCurrent: () => {}, afterEffect: async () => {} }),
      },
    });
    if (reopened.status !== "ready") {
      throw new Error(reopened.reason);
    }
    expect(await reopened.transaction.reconcile()).toMatchObject({ status: "verified" });
    expect(await reopened.transaction.rollback()).toMatchObject({ status: "verified" });
    await expect(fs.stat(descriptor!.stageRoot)).resolves.toBeDefined();
    expect(
      await reopened.transaction.retire({ state: "unselected", ownerRevision: 1 }),
    ).toMatchObject({ status: "verified" });
    await expect(fs.stat(descriptor!.stageRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it.each(["descriptor", "activation"] as const)(
  "preserves a Recovery-owned stage when the %s commit acknowledgement fails",
  async (failure) => {
    await withTestDir({ prefix: "openclaw-package-owned-stage-" }, async (base) => {
      const f = await createPackageSwapFixture(base);
      let descriptor: PackageTransactionDescriptor | undefined;
      const beforeActivate = vi.fn(async () => {});
      const result = await runGlobalPackageUpdateSteps({
        installTarget: f.params.installTarget,
        packageName: "openclaw",
        installSpec: "openclaw@2.0.0",
        runCommand: createRootRunner(f.globalRoot),
        timeoutMs: 1000,
        beforeActivate,
        runStep: async ({ name, argv }) => {
          const prefix = argv[argv.indexOf("--prefix") + 1];
          if (!prefix) {
            throw new Error("missing staged prefix");
          }
          await writePackageRoot(path.join(prefix, "lib", "node_modules", "openclaw"), "2.0.0");
          await fs.mkdir(path.join(prefix, "bin"), { recursive: true });
          await fs.writeFile(path.join(prefix, "bin", "openclaw"), "candidate launcher\n");
          return { name, command: argv.join(" "), cwd: prefix, durationMs: 0, exitCode: 0 };
        },
        recovery: {
          transactionId: randomUUID(),
          persistDescriptor: async (observed) => {
            descriptor = observed.descriptor;
            if (failure === "descriptor") {
              throw new Error("descriptor acknowledgement lost");
            }
            return { assertCurrent: () => {} };
          },
          beforeEffect: async () => {
            throw new Error("activation acknowledgement lost");
          },
        },
      });
      expect(result.failedStep?.stderrTail).toContain("acknowledgement lost");
      expect(beforeActivate).toHaveBeenCalledTimes(failure === "activation" ? 1 : 0);
      await expect(
        fs.readFile(path.join(descriptor!.stageRoot, "package.json"), "utf8"),
      ).resolves.toContain('"version":"2.0.0"');
      await expect(
        fs.readFile(path.join(f.packageRoot, "package.json"), "utf8"),
      ).resolves.toContain('"version":"1.0.0"');
      await expect(fs.readFile(f.launcher, "utf8")).resolves.toBe("old launcher\n");
    });
  },
);

it("keeps the existing launcher when a copy is interrupted and reopens the original intent", async () => {
  await withTestDir({ prefix: "openclaw-package-partial-launcher-" }, async (base) => {
    const hooks: PackageRecoveryHooks = {
      transactionId: randomUUID(),
      persistDescriptor: async () => ({ assertCurrent: () => {} }),
      beforeEffect: async () => ({ assertCurrent: () => {}, afterEffect: async () => {} }),
    };
    const f = await createRetainedPackageSwap(base, hooks);
    const transaction = f.transaction.recovery!;
    const descriptor = transaction.descriptor();
    const sourceLauncher = path.join(descriptor.shimBackupRoot!, path.basename(f.launcher));
    const original = fs.copyFile.bind(fs);
    const copy = vi.spyOn(fs, "copyFile").mockImplementation(async (source, destination, mode) => {
      if (source === sourceLauncher) {
        await fs.writeFile(destination, "partial copy");
        throw new Error("interrupted launcher copy");
      }
      return original(source, destination, mode);
    });
    try {
      expect(await transaction.rollback()).toMatchObject({
        status: "unavailable",
        pendingEffect: { action: "restore" },
      });
    } finally {
      copy.mockRestore();
    }
    await expect(fs.readFile(f.launcher, "utf8")).resolves.toBe("candidate launcher\n");
    expect(await fs.readdir(path.dirname(f.launcher))).not.toContainEqual(
      expect.stringMatching(/^\.openclaw-shim-stage-/),
    );
    const reopened = await reopenPackageUpdateTransaction({
      descriptor: transaction.descriptor(),
      pendingEffect: transaction.pendingEffect(),
      expectedLiveRoot: f.packageRoot,
      expectedBinDir: path.dirname(f.launcher),
      expectedTransactionId: hooks.transactionId,
      hooks,
    });
    if (reopened.status !== "ready") {
      throw new Error(reopened.reason);
    }
    expect(await reopened.transaction.rollback()).toMatchObject({ status: "verified" });
    await expect(fs.readFile(f.launcher, "utf8")).resolves.toBe("old launcher\n");
    expect(await fs.readdir(path.dirname(f.launcher))).not.toContainEqual(
      expect.stringMatching(/^\.openclaw-shim-stage-/),
    );
  });
});

it.each([false, true])(
  "joins independent root reads within one unchanged deadline (stall=%s)",
  async (stall) => {
    await withTestDir({ prefix: "package-root-observation-" }, async (base) => {
      const hooks: PackageRecoveryHooks = {
        transactionId: randomUUID(),
        persistDescriptor: async () => ({ assertCurrent() {} }),
        beforeEffect: async () => ({ assertCurrent() {}, afterEffect: async () => {} }),
      };
      const f = await createRetainedPackageSwap(base, hooks);
      const descriptor = f.transaction.recovery!.descriptor();
      const targets = new Set(
        [descriptor.liveRoot, descriptor.backupRoot].map((root) => path.join(root, "package.json")),
      );
      const entered = new Set<string>();
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const open = fs.open.bind(fs);
      const opens: ReturnType<typeof fs.open>[] = [];
      const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const file = String(args[0]);
        if (targets.has(file) && !entered.has(file)) {
          entered.add(file);
          if (entered.size === targets.size && !stall) {
            release();
          }
          await barrier;
        }
        const opening = open(...args);
        opens.push(opening);
        return opening;
      });
      try {
        const result = await createPackageRecoveryTransaction(descriptor, hooks, 500).observe();
        expect(entered.size).toBe(2);
        expect(result).toMatchObject(
          stall
            ? {
                status: "unavailable",
                reason: "Package rollback verification timed out",
              }
            : {
                status: "verified",
                observation: { previous: "retained", candidate: "live", launchers: "candidate" },
              },
        );
      } finally {
        release();
        // Let late OS opens settle before deleting their real fixture roots.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        for (const handle of await Promise.all(opens)) {
          await expect.poll(() => handle.fd).toBe(-1);
        }
        spy.mockRestore();
      }
    });
  },
);
