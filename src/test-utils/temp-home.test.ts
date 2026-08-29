// Tests temporary home directory helper setup and cleanup.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHomeCore } from "../plugin-sdk/test-helpers/temp-home.js";
import { captureEnv, captureFullEnv, withEnvAsync } from "./env.js";
import { createTempHomeEnv } from "./temp-home.js";

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.stat(targetPath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`expected ${targetPath} to be removed`);
}

describe("createTempHomeEnv", () => {
  it.each(["directory", "environment"])(
    "rolls back failed %s acquisition without removing a sibling home",
    async (stage) => {
      const parent = await fs.mkdtemp(path.join(os.tmpdir(), "temp-home-acquisition-"));
      const prefix = path.join(path.basename(parent), "shared-");
      const sibling = await createTempHomeEnv(prefix);
      const sharedRoot = path.dirname(sibling.home);
      const marker = path.join(sibling.home, "keep.txt");
      await fs.writeFile(marker, "sibling");
      try {
        await withEnvAsync({ USERPROFILE: undefined, OPENCLAW_STATE_DIR: "" }, async () => {
          const keys = ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "OPENCLAW_STATE_DIR"];
          const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
          const snapshot = captureEnv(keys);
          const fault = new Error(`failed ${stage} acquisition`);
          const mkdir = fs.mkdir;
          const set = Reflect.set;
          const faultSpy =
            stage === "directory"
              ? vi.spyOn(fs, "mkdir").mockImplementationOnce(async (...args) => {
                  await mkdir(...args);
                  throw fault;
                })
              : vi.spyOn(Reflect, "set").mockImplementation((...args) => {
                  const result = set(...args);
                  const [target, key] = args;
                  if (target === process.env && key === "USERPROFILE") {
                    faultSpy.mockRestore();
                    throw fault;
                  }
                  return result;
                });
          try {
            await expect(createTempHomeEnv(prefix)).rejects.toBe(fault);
            expect(Object.fromEntries(keys.map((key) => [key, process.env[key]]))).toEqual(
              previous,
            );
            expect(await fs.readdir(sharedRoot)).toEqual([path.basename(sibling.home)]);
            expect(await fs.readFile(marker, "utf8")).toBe("sibling");
            faultSpy.mockRestore();
            const recovered = await createTempHomeEnv(prefix);
            expect(path.dirname(recovered.home)).toBe(sharedRoot);
            expect(recovered.home).not.toBe(sibling.home);
            await recovered.restore();
            expect(await fs.readdir(sharedRoot)).toEqual([path.basename(sibling.home)]);
          } finally {
            faultSpy.mockRestore();
            snapshot.restore();
          }
        });
      } finally {
        await sibling.restore();
        await fs.rm(parent, { recursive: true, force: true });
      }
    },
  );

  it("sets home env vars and restores them on cleanup", async () => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;

    const tempHome = await createTempHomeEnv("openclaw-temp-home-");
    expect(process.env.HOME).toBe(tempHome.home);
    expect(process.env.USERPROFILE).toBe(tempHome.home);
    expect(process.env.OPENCLAW_STATE_DIR).toBe(path.join(tempHome.home, ".openclaw"));
    const homeStat = await fs.stat(tempHome.home);
    expect(homeStat.isDirectory()).toBe(true);

    await tempHome.restore();

    expect(process.env.HOME).toBe(previousHome);
    expect(process.env.USERPROFILE).toBe(previousUserProfile);
    expect(process.env.OPENCLAW_STATE_DIR).toBe(previousStateDir);
    await expectPathMissing(tempHome.home);
  });
});

describe("withTempHome acquisition", () => {
  let sandbox: string;
  let prefix: string;
  let snapshot: ReturnType<typeof captureFullEnv>;

  beforeEach(async () => {
    snapshot = captureFullEnv();
    sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "home-acquisition-")));
    prefix = `${path.basename(sandbox)}-`;
    vi.spyOn(os, "tmpdir").mockReturnValue(sandbox);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    snapshot.restore();
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it.each(["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"])(
    "rejects reserved %s before allocating a home",
    async (key) => {
      const body = vi.fn(async () => undefined);
      await expect(withTempHomeCore(body, { prefix, env: { [key]: "invalid" } })).rejects.toThrow(
        `withTempHome: use built-in home env (got ${key})`,
      );
      expect(body).not.toHaveBeenCalled();
      expect(await fs.readdir(sandbox)).toEqual([]);
    },
  );

  it.each([false, true])(
    "rolls back a throwing env callback before reuse (skipHomeCleanup=%s)",
    async (skipHomeCleanup) => {
      const callerHome = path.join(sandbox, "caller");
      await fs.mkdir(callerHome);
      await fs.writeFile(path.join(callerHome, "keep"), "caller-owned");
      await withEnvAsync(
        {
          OPENCLAW_HOME: callerHome,
          OPENCLAW_STATE_DIR: path.join(callerHome, ".openclaw"),
          ACQUISITION_ADDED: undefined,
          ACQUISITION_CHANGED: "",
          ACQUISITION_DELETED: "caller",
        },
        async () => {
          const callerEnv = { ...process.env };
          const failure = new Error("env acquisition failed");
          const body = vi.fn(async () => undefined);
          let failedHome = "";
          await expect(
            withTempHomeCore(body, {
              prefix,
              skipHomeCleanup,
              env: {
                ACQUISITION_ADDED: "temporary",
                ACQUISITION_CHANGED: "temporary",
                ACQUISITION_DELETED: undefined,
                ACQUISITION_THROW: (home) => {
                  failedHome = home;
                  throw failure;
                },
              },
            }),
          ).rejects.toBe(failure);
          expect(body).not.toHaveBeenCalled();
          const changedKeys = [
            ...new Set([...Object.keys(callerEnv), ...Object.keys(process.env)]),
          ].filter((key) => callerEnv[key] !== process.env[key]);
          expect.soft(changedKeys).toEqual([]);
          await expectPathMissing(failedHome);
          const root = path.dirname(failedHome);
          expect(await fs.readdir(root)).toEqual([]);
          const result = await withTempHomeCore(
            async (home) => {
              expect(home).not.toBe(failedHome);
              expect(path.dirname(home)).toBe(root);
              expect(process.env.HOME).toBe(home);
              return "recovered";
            },
            { prefix },
          );
          expect(result).toBe("recovered");
          expect(process.env.HOME).toBe(callerEnv.HOME);
          expect(await fs.readFile(path.join(callerHome, "keep"), "utf8")).toBe("caller-owned");
          expect(await fs.readdir(root)).toEqual([]);
        },
      );
    },
  );

  it.each(["case", "sessions"])("rolls back partial %s directory creation", async (stage) => {
    const callerEnv = { ...process.env };
    const failure = new Error(`${stage} directory failed`);
    const mkdir = fs.mkdir;
    let failedHome = "";
    const fault = vi.spyOn(fs, "mkdir").mockImplementation(async (target, options) => {
      const result = await mkdir(target, options);
      const targetPath = String(target);
      const isCase = path.basename(targetPath).startsWith("case-");
      if (
        (stage === "case" && isCase) ||
        (stage === "sessions" && path.basename(targetPath) === "sessions")
      ) {
        failedHome = isCase ? targetPath : path.resolve(targetPath, "../../../..");
        throw failure;
      }
      return result;
    });
    const body = vi.fn(async () => undefined);
    try {
      await expect(withTempHomeCore(body, { prefix })).rejects.toBe(failure);
    } finally {
      fault.mockRestore();
    }
    expect(body).not.toHaveBeenCalled();
    const changedKeys = [
      ...new Set([...Object.keys(callerEnv), ...Object.keys(process.env)]),
    ].filter((key) => callerEnv[key] !== process.env[key]);
    expect.soft(changedKeys).toEqual([]);
    await expectPathMissing(failedHome);
  });

  it.each([false, true])(
    "preserves body-failure retention (skipHomeCleanup=%s)",
    async (skipHomeCleanup) => {
      const failure = new Error("body failed");
      const callerHome = process.env.HOME;
      let acquiredHome = "";
      await expect(
        withTempHomeCore(
          async (home) => {
            acquiredHome = home;
            await fs.writeFile(path.join(home, "retained"), "body artifact");
            throw failure;
          },
          { prefix, skipHomeCleanup, skipSessionCleanup: true },
        ),
      ).rejects.toBe(failure);
      expect(process.env.HOME).toBe(callerHome);
      if (skipHomeCleanup) {
        expect(await fs.readFile(path.join(acquiredHome, "retained"), "utf8")).toBe(
          "body artifact",
        );
      } else {
        await expectPathMissing(acquiredHome);
      }
    },
  );
});
