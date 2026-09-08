import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  reopenPackageUpdateTransaction,
  type PackageRecoveryEffect,
  type PackageRecoveryHooks,
  type PackageTransactionDescriptor,
} from "./package-update-recovery.js";
import { writePackageRoot } from "./package-update-steps.test-support.js";
import { swapStagedPackageInstall, type PackageUpdateTransaction } from "./package-update-swap.js";
import {
  createPackageSwapFixture,
  createRetainedPackageSwap,
} from "./package-update-swap.test-support.js";

const accepted: PackageRecoveryHooks = {
  transactionId: randomUUID(),
  persistDescriptor: async () => ({ assertCurrent: () => {} }),
  beforeEffect: async () => ({ assertCurrent: () => {}, afterEffect: async () => {} }),
};

async function retained(base: string, hooks = accepted) {
  const fixture = await createPackageSwapFixture(base);
  let transaction: PackageUpdateTransaction | undefined;
  const result = await swapStagedPackageInstall({
    ...fixture.params,
    recovery: hooks,
    onTransaction: (value) => {
      transaction = value;
    },
  });
  expect(result.status, result.step.stderrTail ?? "").toBe("committed");
  if (!transaction?.recovery) {
    throw new Error("Missing package recovery owner");
  }
  return { ...fixture, transaction, recovery: transaction.recovery };
}

async function reopened(
  recovery: Awaited<ReturnType<typeof retained>>["recovery"],
  hooks = accepted,
) {
  const descriptor = recovery.descriptor();
  return reopenPackageUpdateTransaction({
    descriptor: JSON.stringify(descriptor),
    expectedLiveRoot: descriptor.liveRoot,
    expectedBinDir: descriptor.binDir,
    expectedTransactionId: descriptor.transactionId,
    pendingEffect: recovery.pendingEffect(),
    hooks,
  });
}

it("preserves recovery material through rollback and finalizer completion", async () => {
  await withTestDir({ prefix: "openclaw-package-retention-" }, async (base) => {
    const fixture = await createPackageSwapFixture(base);
    let transaction: PackageUpdateTransaction | undefined;
    const result = await swapStagedPackageInstall({
      ...fixture.params,
      recovery: {
        ...accepted,
        beforeEffect: async () => ({ assertCurrent: () => {}, afterEffect: async () => {} }),
      },
      onTransaction: (value) => {
        transaction = value;
      },
    });
    expect(result.status).toBe("committed");
    expect(
      await transaction!.recovery!.retain({
        state: "selected",
        pairId: randomUUID(),
        ownerRevision: 1,
      }),
    ).toMatchObject({ status: "verified" });
    expect(await transaction!.rollback()).toMatchObject({ exitCode: 0 });
    await transaction!.complete({ activationVerified: false });
    await expect(
      fs.readFile(path.join(fixture.packageRoot, "package.json"), "utf8"),
    ).resolves.toContain('"version":"1.0.0"');
    await expect(
      fs.readFile(path.join(`${transaction!.backupRoot}.candidate`, "package.json"), "utf8"),
    ).resolves.toContain('"version":"2.0.0"');
    expect(
      (await fs.readdir(fixture.globalRoot)).some((name) =>
        name.startsWith(".openclaw.shim-backup-"),
      ),
    ).toBe(true);
  });
});

it.each([false, true])(
  "reopens a serialized transaction after candidate displacement=%s",
  async (displaced) => {
    await withTestDir({ prefix: "openclaw-package-reopen-" }, async (base) => {
      const f = await retained(base);
      if (displaced) {
        await fs.rename(f.packageRoot, `${f.transaction.backupRoot}.candidate`);
      }
      const result = await reopened(f.recovery);
      expect(result.status).toBe("ready");
      if (result.status !== "ready") {
        throw new Error(result.reason);
      }
      const restored = await result.transaction.rollback();
      expect(restored).toMatchObject({
        status: "verified",
        observation: { previous: "live", candidate: "displaced", launchers: "previous" },
      });
      const launcherBefore = await fs.lstat(f.launcher, { bigint: true });
      expect(await result.transaction.rollback()).toMatchObject({ status: "verified" });
      expect((await fs.lstat(f.launcher, { bigint: true })).ino).toBe(launcherBefore.ino);
      await expect(fs.readFile(f.launcher, "utf8")).resolves.toBe("old launcher\n");
    });
  },
);

it.each(["changed", "missing", "wrong resource", "unknown version"] as const)(
  "refuses %s descriptor evidence without an effect",
  async (failure) => {
    await withTestDir({ prefix: "openclaw-package-reopen-refusal-" }, async (base) => {
      const f = await retained(base);
      const beforeEffect = vi.fn(accepted.beforeEffect);
      const descriptor = f.recovery.descriptor();
      if (failure === "changed") {
        await fs.writeFile(path.join(descriptor.backupRoot, "dist", "index.js"), "changed");
      }
      if (failure === "missing") {
        await fs.rename(descriptor.backupRoot, `${descriptor.backupRoot}.preserved`);
      }
      const result = await reopenPackageUpdateTransaction({
        descriptor:
          failure === "unknown version"
            ? { ...descriptor, version: 99 }
            : JSON.stringify(descriptor),
        expectedLiveRoot:
          failure === "wrong resource" ? `${descriptor.liveRoot}.other` : descriptor.liveRoot,
        expectedTransactionId: descriptor.transactionId,
        expectedBinDir: descriptor.binDir,
        hooks: { ...accepted, beforeEffect },
      });
      expect(result.status).toBe(
        failure === "changed" || failure === "wrong resource" ? "conflict" : "unavailable",
      );
      expect(beforeEffect).not.toHaveBeenCalled();
      await expect(
        fs.readFile(path.join(f.packageRoot, "package.json"), "utf8"),
      ).resolves.toContain('"version":"2.0.0"');
    });
  },
);

it("awaits durable descriptor preparation before service preparation and mutation", async () => {
  await withTestDir({ prefix: "openclaw-package-intent-" }, async (base) => {
    const f = await createPackageSwapFixture(base);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const beforeActivate = vi.fn(async () => {});
    const observed: unknown[] = [];
    const updating = swapStagedPackageInstall({
      ...f.params,
      beforeActivate,
      recovery: {
        ...accepted,
        persistDescriptor: async (prepared) => {
          expect(prepared.descriptor.previous?.version).toBe("1.0.0");
          entered.resolve();
          await release.promise;
          return { assertCurrent: () => {} };
        },
        beforeEffect: async () => {
          return {
            assertCurrent: () => {},
            afterEffect: async (value) => {
              observed.push(value);
            },
          };
        },
      },
    });
    await entered.promise;
    expect(beforeActivate).not.toHaveBeenCalled();
    await expect(fs.readFile(f.launcher, "utf8")).resolves.toBe("old launcher\n");
    await expect(fs.readFile(path.join(f.packageRoot, "package.json"), "utf8")).resolves.toContain(
      '"version":"1.0.0"',
    );
    release.resolve();
    expect((await updating).status).toBe("committed");
    expect(observed).toMatchObject([
      { status: "verified", observation: { candidate: "live", previous: "retained" } },
    ]);
  });
});

it.each([
  { previous: false, rollback: false },
  { previous: false, rollback: true },
  { previous: true, rollback: true },
])(
  "explicitly retires an unselected transaction: previous=$previous rollback=$rollback",
  async ({ previous, rollback }) => {
    await withTestDir({ prefix: "openclaw-package-absence-retirement-" }, async (base) => {
      const f = await createPackageSwapFixture(base);
      if (!previous) {
        await fs.rename(f.packageRoot, path.join(base, "preserved-original"));
      }
      let transaction: PackageUpdateTransaction | undefined;
      expect(
        (
          await swapStagedPackageInstall({
            ...f.params,
            recovery: accepted,
            onTransaction: (value) => {
              transaction = value;
            },
          })
        ).status,
      ).toBe("committed");
      const owner = transaction!.recovery!;
      if (rollback) {
        expect(await owner.rollback()).toMatchObject({ status: "verified" });
      }
      const descriptor = owner.descriptor();
      await transaction!.complete({ activationVerified: !rollback });
      await expect(fs.lstat(descriptor.shimBackupRoot!)).resolves.toBeDefined();
      expect(await owner.retire({ state: "unselected", ownerRevision: 1 })).toMatchObject({
        status: "verified",
      });
      await expect(fs.lstat(descriptor.shimBackupRoot!)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.lstat(`${descriptor.backupRoot}.candidate`)).rejects.toMatchObject({
        code: "ENOENT",
      });
      if (rollback && !previous) {
        await expect(fs.lstat(f.packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(
          fs.readFile(path.join(f.packageRoot, "package.json"), "utf8"),
        ).resolves.toContain(`"version":"${rollback ? "1.0.0" : "2.0.0"}"`);
      }
    });
  },
);

it("reports conflicting pending descriptor evidence without effects", async () => {
  await withTestDir({ prefix: "openclaw-package-pending-conflict-" }, async (base) => {
    const f = await retained(base);
    const descriptor = f.recovery.descriptor();
    const beforeEffect = vi.fn(accepted.beforeEffect);
    const result = await reopenPackageUpdateTransaction({
      descriptor,
      pendingEffect: {
        effectId: randomUUID(),
        action: "restore",
        descriptor: { ...descriptor, transactionId: randomUUID() },
      },
      expectedLiveRoot: descriptor.liveRoot,
      expectedBinDir: descriptor.binDir,
      expectedTransactionId: descriptor.transactionId,
      hooks: { ...accepted, beforeEffect },
    });
    expect(result.status).toBe("conflict");
    expect(beforeEffect).not.toHaveBeenCalled();
    await expect(fs.readFile(f.launcher, "utf8")).resolves.toBe("candidate launcher\n");
  });
});

it("reports and preserves the displaced candidate when rollback compensation also fails", async () => {
  await withTestDir({ prefix: "openclaw-package-double-rename-failure-" }, async (base) => {
    const f = await createRetainedPackageSwap(base);
    const displaced = `${f.transaction.backupRoot}.candidate`;
    const original = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (destination === f.packageRoot) {
        throw new Error("publication or compensation denied");
      }
      return original(source, destination);
    });
    try {
      expect(await f.transaction.rollback()).toMatchObject({
        exitCode: 1,
        activePackageRoot: null,
        stderrTail: expect.stringContaining(displaced),
      });
    } finally {
      rename.mockRestore();
    }
    await f.transaction.complete({ activationVerified: false });
    await expect(fs.readFile(path.join(displaced, "package.json"), "utf8")).resolves.toContain(
      '"version":"2.0.0"',
    );
    await expect(
      fs.readFile(path.join(f.transaction.backupRoot, "package.json"), "utf8"),
    ).resolves.toContain('"version":"1.0.0"');
  });
});

it("revalidates retained bytes after the awaited restore intent", async () => {
  await withTestDir({ prefix: "openclaw-package-restore-intent-" }, async (base) => {
    const f = await retained(base);
    const loaded = await reopened(f.recovery, {
      ...accepted,
      beforeEffect: async () => {
        await fs.writeFile(
          path.join(f.transaction.backupRoot, "dist", "index.js"),
          "altered during intent",
        );
        return {
          assertCurrent: () => {},
          afterEffect: async () => {
            throw new Error("must not observe success");
          },
        };
      },
    });
    if (loaded.status !== "ready") {
      throw new Error(loaded.reason);
    }
    expect(await loaded.transaction.rollback()).toMatchObject({ status: "conflict" });
    await expect(fs.readFile(f.launcher, "utf8")).resolves.toBe("candidate launcher\n");
    await expect(fs.readFile(path.join(f.packageRoot, "package.json"), "utf8")).resolves.toContain(
      '"version":"2.0.0"',
    );
  });
});

it.each(["inventory", "identity"] as const)(
  "rejects changed launcher-backup %s before reopening",
  async (change) => {
    await withTestDir({ prefix: "openclaw-package-shim-evidence-" }, async (base) => {
      const f = await retained(base);
      const root = f.recovery.descriptor().shimBackupRoot!;
      if (change === "inventory") {
        await fs.writeFile(path.join(root, "unowned"), "preserve");
      } else {
        await fs.rename(root, `${root}.preserved`);
        await fs.cp(`${root}.preserved`, root, { recursive: true });
      }
      expect(await reopened(f.recovery)).toMatchObject({ status: "conflict" });
    });
  },
);

it.each(["rejected", "stale"] as const)(
  "leaves package and service intact for %s descriptor preparation",
  async (failure) => {
    await withTestDir({ prefix: "openclaw-package-intent-refusal-" }, async (base) => {
      const f = await createPackageSwapFixture(base);
      const beforeActivate = vi.fn(async () => {});
      const result = await swapStagedPackageInstall({
        ...f.params,
        beforeActivate,
        recovery: {
          ...accepted,
          persistDescriptor: async () => {
            if (failure === "rejected") {
              throw new Error("intent commit refused");
            }
            return {
              assertCurrent: () => {
                throw new Error("owner lost");
              },
            };
          },
        },
      });
      expect(result.status).toBe("failed");
      expect(beforeActivate).not.toHaveBeenCalled();
      await expect(fs.readFile(f.launcher, "utf8")).resolves.toBe("old launcher\n");
      await expect(
        fs.readFile(path.join(f.packageRoot, "package.json"), "utf8"),
      ).resolves.toContain('"version":"1.0.0"');
    });
  },
);

it.each(["none", "between roots", "partial tree"] as const)(
  "preserves the successor pair through retirement interrupted %s",
  async (interruption) => {
    await withTestDir({ prefix: "openclaw-package-retirement-" }, async (base) => {
      const f = await retained(path.join(base, "first"));
      expect(await f.recovery.retire({ state: "unselected", ownerRevision: 1 })).toMatchObject({
        status: "conflict",
      });
      await expect(fs.lstat(f.transaction.backupRoot)).resolves.toBeDefined();
      const selected = { state: "selected" as const, pairId: randomUUID(), ownerRevision: 1 };
      expect(await f.recovery.retain(selected)).toMatchObject({
        status: "verified",
        descriptor: { retention: selected },
      });
      await f.transaction.complete({ activationVerified: true });
      await expect(fs.stat(f.transaction.backupRoot)).resolves.toBeDefined();
      const loaded = await reopened(f.recovery);
      if (loaded.status !== "ready") {
        throw new Error(loaded.reason);
      }
      expect(loaded.transaction.descriptor().retention).toEqual(selected);
      expect(
        await loaded.transaction.retire({ state: "unselected", ownerRevision: 2 }),
      ).toMatchObject({ status: "conflict" });
      await expect(fs.lstat(f.transaction.backupRoot)).resolves.toBeDefined();

      const second = await createPackageSwapFixture(path.join(base, "second"));
      await writePackageRoot(second.params.stage.packageRoot, "3.0.0");
      let successor: PackageUpdateTransaction | undefined;
      const result = await swapStagedPackageInstall({
        ...second.params,
        installTarget: f.params.installTarget,
        recovery: { ...accepted, transactionId: randomUUID() },
        onTransaction: (value) => {
          successor = value;
        },
      });
      expect(result.status).toBe("committed");
      const next = successor!.recovery!.descriptor();
      const replacementPairId = randomUUID();
      expect(
        await successor!.recovery!.retain({
          state: "selected",
          pairId: replacementPairId,
          ownerRevision: 2,
        }),
      ).toMatchObject({ status: "verified" });
      const decision = {
        state: "superseded" as const,
        pairId: selected.pairId,
        ownerRevision: 3,
        replacement: {
          pairId: replacementPairId,
          transactionId: next.transactionId,
          live: next.candidate,
          retainedRoot: next.backupRoot,
          retained: next.previous!,
          launchers: next.launchers.map((entry) => ({
            name: entry.name,
            fingerprint: entry.candidate,
          })),
        },
      };
      expect(
        await loaded.transaction.retire({
          ...decision,
          replacement: { ...decision.replacement, retainedRoot: f.transaction.backupRoot },
        }),
      ).toMatchObject({ status: "conflict" });
      expect(
        await loaded.transaction.retire({
          ...decision,
          replacement: {
            ...decision.replacement,
            retainedRoot: next.liveRoot,
            retained: next.candidate,
          },
        }),
      ).toMatchObject({ status: "conflict" });
      if (interruption !== "none") {
        const original = fs.rm.bind(fs);
        const remove = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
          if (interruption === "partial tree" && target === f.transaction.backupRoot) {
            await fs.unlink(path.join(f.transaction.backupRoot, "dist", "index.js"));
            throw new Error("interrupted recursive retirement");
          }
          if (
            interruption === "between roots" &&
            target === f.recovery.descriptor().shimBackupRoot
          ) {
            throw new Error("interrupted shim retirement");
          }
          return original(target, options);
        });
        try {
          expect(await loaded.transaction.retire(decision)).toMatchObject({
            status: "unavailable",
            pendingEffect: { action: "retire" },
            descriptor: { retention: decision },
          });
        } finally {
          remove.mockRestore();
        }
        const pending = loaded.transaction.pendingEffect();
        const resumed = await reopened(loaded.transaction);
        if (interruption === "partial tree") {
          // A changed aggregate tree is not proof of which entries rm removed.
          // Refuse further deletion, retain the original intent and remaining evidence.
          expect(resumed).toMatchObject({ status: "conflict", pendingEffect: pending });
          await expect(fs.lstat(f.transaction.backupRoot)).resolves.toBeDefined();
          await expect(fs.lstat(next.backupRoot)).resolves.toBeDefined();
          return;
        }
        if (resumed.status !== "ready") {
          throw new Error(resumed.reason);
        }
        expect(resumed.observed.descriptor.retention).toEqual(decision);
        expect(await resumed.transaction.retire(decision)).toMatchObject({ status: "verified" });
      } else {
        expect(await loaded.transaction.retire(decision)).toMatchObject({ status: "verified" });
      }
      await expect(fs.lstat(f.transaction.backupRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs.readFile(path.join(next.backupRoot, "package.json"), "utf8"),
      ).resolves.toContain('"version":"2.0.0"');
      await expect(
        fs.readFile(path.join(f.packageRoot, "package.json"), "utf8"),
      ).resolves.toContain('"version":"3.0.0"');
      const replay = await reopened(loaded.transaction);
      if (replay.status !== "ready") {
        throw new Error(replay.reason);
      }
      expect(await replay.transaction.retire(decision)).toMatchObject({ status: "verified" });
      expect(await replay.transaction.rollback()).toMatchObject({ status: "conflict" });
    });
  },
);

it("records activation intent only after the caller binds its real checkpoint", async () => {
  await withTestDir({ prefix: "openclaw-package-checkpoint-order-" }, async (base) => {
    const f = await createPackageSwapFixture(base);
    let checkpointBound = false;
    const result = await swapStagedPackageInstall({
      ...f.params,
      beforeActivate: async () => {
        checkpointBound = true;
      },
      recovery: {
        ...accepted,
        beforeEffect: async () => {
          if (!checkpointBound) {
            throw new Error("Package activation requires a durable checkpoint binding");
          }
          return { assertCurrent: () => {}, afterEffect: async () => {} };
        },
      },
    });
    expect(result.status, result.step.stderrTail ?? "").toBe("committed");
  });
});

it("reconciles the original restore intent after its observation commit fails", async () => {
  await withTestDir({ prefix: "openclaw-package-pending-restore-" }, async (base) => {
    let pending: string | null = null;
    let failObservation = true;
    const hooks: PackageRecoveryHooks = {
      ...accepted,
      beforeEffect: async (effect, context) => {
        expect(context.mode).toBe(pending ? "resume" : "new");
        if (pending && effect.effectId !== pending) {
          throw new Error("Outstanding effect must be reconciled");
        }
        pending = effect.effectId;
        return {
          assertCurrent: () => {},
          afterEffect: async () => {
            if (effect.action === "restore" && failObservation) {
              failObservation = false;
              throw new Error("observation commit failed");
            }
            pending = null;
          },
        };
      },
    };
    const f = await retained(base, hooks);
    expect(await f.recovery.rollback()).toMatchObject({
      status: "unavailable",
      pendingEffect: { action: "restore" },
      facts: {
        roots: expect.arrayContaining([
          { path: f.packageRoot, identity: expect.any(String), match: "previous" },
        ]),
      },
    });
    const originalEffect = pending;
    const loaded = await reopened(f.recovery, hooks);
    if (loaded.status !== "ready") {
      throw new Error(loaded.reason);
    }
    expect(await loaded.transaction.rollback()).toMatchObject({ status: "verified" });
    expect(originalEffect).not.toBeNull();
    expect(pending).toBeNull();
    await expect(fs.readFile(f.launcher, "utf8")).resolves.toBe("old launcher\n");
  });
});

it("reconciles an interrupted activation before admitting a separate restore effect", async () => {
  await withTestDir({ prefix: "openclaw-package-interrupted-activation-" }, async (base) => {
    const f = await createPackageSwapFixture(base);
    const saved: { descriptor?: PackageTransactionDescriptor; pending?: PackageRecoveryEffect } =
      {};
    const after = vi.fn(async () => {});
    const hooks: PackageRecoveryHooks = {
      ...accepted,
      persistDescriptor: async (value) => {
        saved.descriptor = value.descriptor;
        return { assertCurrent: () => {} };
      },
      beforeEffect: async (effect, context) => {
        if (saved.pending && saved.pending.effectId !== effect.effectId) {
          throw new Error("unresolved intent");
        }
        expect(context.mode).toBe(saved.pending ? "resume" : "new");
        saved.pending = effect;
        return {
          assertCurrent: () => {},
          afterEffect: async (value, outcome) => {
            await after();
            saved.descriptor = value.descriptor;
            if (effect.action === "activate") {
              expect(outcome).toBe("interrupted");
            }
            saved.pending = undefined;
          },
        };
      },
    };
    const original = fs.copyFile.bind(fs);
    const copy = vi.spyOn(fs, "copyFile").mockImplementation(async (source, destination, mode) => {
      if (source === path.join(f.params.stage.layout.binDir, path.basename(f.launcher))) {
        await fs.unlink(f.launcher);
        throw new Error("interrupted activation launcher");
      }
      return original(source, destination, mode);
    });
    try {
      const result = await swapStagedPackageInstall({ ...f.params, recovery: hooks });
      expect(result.status).toBe("failed");
    } finally {
      copy.mockRestore();
    }
    const open = () =>
      reopenPackageUpdateTransaction({
        descriptor: saved.descriptor,
        pendingEffect: saved.pending,
        expectedLiveRoot: f.packageRoot,
        expectedBinDir: path.dirname(f.launcher),
        expectedTransactionId: hooks.transactionId,
        hooks,
      });
    const loaded = await open();
    if (loaded.status !== "ready") {
      throw new Error(loaded.reason);
    }
    expect(loaded.observed.observation.launchers).toBe("interrupted");
    expect(await loaded.transaction.rollback()).toMatchObject({ status: "conflict" });
    expect(await loaded.transaction.reconcile()).toMatchObject({ status: "verified" });
    const reconciled = await open();
    if (reconciled.status !== "ready") {
      throw new Error(reconciled.reason);
    }
    expect(await reconciled.transaction.rollback()).toMatchObject({
      status: "verified",
      observation: { previous: "live", launchers: "previous" },
      descriptor: { interruptedLaunchers: [] },
    });
    expect(after).toHaveBeenCalledTimes(2);
  });
});

it("reports restored absence without claiming that a previous runtime can restart", async () => {
  await withTestDir({ prefix: "openclaw-package-absence-" }, async (base) => {
    const f = await createPackageSwapFixture(base);
    await fs.rename(f.packageRoot, path.join(base, "preserved-original"));
    let transaction: PackageUpdateTransaction | undefined;
    expect(
      (
        await swapStagedPackageInstall({
          ...f.params,
          recovery: accepted,
          onTransaction: (value) => {
            transaction = value;
          },
        })
      ).status,
    ).toBe("committed");
    expect(await transaction!.rollback()).toMatchObject({
      exitCode: 1,
      activePackageRoot: null,
      stderrTail: "Package absence restored; no previous runtime is available to restart.",
    });
    await expect(fs.lstat(f.packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(f.launcher, "utf8")).resolves.toBe("old launcher\n");
  });
});

it("reconciles an explicitly missing launcher during a pending restore", async () => {
  await withTestDir({ prefix: "openclaw-package-interrupted-launcher-" }, async (base) => {
    const f = await retained(base);
    const copy = vi.spyOn(fs, "copyFile").mockRejectedValueOnce(new Error("interrupted copy"));
    try {
      expect(await f.recovery.rollback()).toMatchObject({ status: "unavailable" });
    } finally {
      copy.mockRestore();
    }
    await fs.unlink(f.launcher);
    await expect(fs.lstat(f.launcher)).rejects.toMatchObject({ code: "ENOENT" });
    const loaded = await reopened(f.recovery);
    expect(loaded.status).toBe("ready");
    if (loaded.status !== "ready") {
      throw new Error(loaded.reason);
    }
    expect(await loaded.transaction.rollback()).toMatchObject({ status: "verified" });
    await expect(fs.readFile(f.launcher, "utf8")).resolves.toBe("old launcher\n");
  });
});
