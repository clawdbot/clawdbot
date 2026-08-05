import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquirePluginLifecycleLease,
  PluginLifecycleLeaseUnavailableError,
  withPluginLifecycleLease,
} from "./plugin-lifecycle-lease.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("plugin lifecycle lease", () => {
  it("serializes lifecycle mutations and permits a new owner after release", async () => {
    const extensionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-lifecycle-"));
    tempDirs.push(extensionsDir);
    const first = await acquirePluginLifecycleLease(extensionsDir);
    await expect(acquirePluginLifecycleLease(extensionsDir)).rejects.toBeInstanceOf(
      PluginLifecycleLeaseUnavailableError,
    );
    await first.release();
    const second = await acquirePluginLifecycleLease(extensionsDir);
    await second.release();
  });

  it("allows nested lifecycle owners in the same async operation", async () => {
    const extensionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-lifecycle-"));
    tempDirs.push(extensionsDir);
    const result = await withPluginLifecycleLease(extensionsDir, async () => {
      return await withPluginLifecycleLease(extensionsDir, async () => "nested");
    });
    expect(result).toBe("nested");
  });

  it("revokes detached descendant authority before a later owner acquires the lease", async () => {
    const extensionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-lifecycle-"));
    tempDirs.push(extensionsDir);
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let entered = false;
    let detached!: Promise<void>;

    await withPluginLifecycleLease(extensionsDir, async () => {
      detached = gate.then(async () => {
        await withPluginLifecycleLease(extensionsDir, async () => {
          entered = true;
        });
      });
    });

    const competing = await acquirePluginLifecycleLease(extensionsDir);
    try {
      resume();
      await expect(detached).rejects.toBeInstanceOf(PluginLifecycleLeaseUnavailableError);
      expect(entered).toBe(false);
    } finally {
      await competing.release();
    }
  });

  it("keeps the physical lease until an already-entered detached child finishes", async () => {
    const extensionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-lifecycle-"));
    tempDirs.push(extensionsDir);
    let finishChild!: () => void;
    const childGate = new Promise<void>((resolve) => {
      finishChild = resolve;
    });
    let childStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      childStarted = resolve;
    });
    let outerSettled = false;

    const outer = withPluginLifecycleLease(extensionsDir, async () => {
      void withPluginLifecycleLease(extensionsDir, async () => {
        childStarted();
        await childGate;
      });
      await started;
    }).finally(() => {
      outerSettled = true;
    });

    await started;
    await Promise.resolve();
    expect(outerSettled).toBe(false);
    await expect(acquirePluginLifecycleLease(extensionsDir)).rejects.toBeInstanceOf(
      PluginLifecycleLeaseUnavailableError,
    );
    finishChild();
    await outer;
    expect(outerSettled).toBe(true);
  });
});
