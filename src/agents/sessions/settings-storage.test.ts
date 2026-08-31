import fs, { existsSync, mkdirSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { waitForFile } from "../../../test/helpers/process-wait.js";
import { runNodeScript } from "../../../test/helpers/run-node-script.js";
import { SettingsManager } from "./settings-manager.js";
import { FileSettingsStorage } from "./settings-storage.js";

const fixtures = createFixtureLifetime();
afterEach(() => fixtures.cleanup());

describe("FileSettingsStorage", () => {
  it("loads missing settings without creating their directories", () => {
    const root = fixtures.createTempDir("openclaw-settings-read-");
    const settingsDir = join(root, "agent");

    SettingsManager.create(root, settingsDir);

    expect(existsSync(settingsDir)).toBe(false);
    expect(existsSync(join(root, ".openclaw"))).toBe(false);
  });

  it("loads absent unlocked settings without syncing writer sidecars", () => {
    const root = fixtures.createTempDir("openclaw-settings-unlocked-");
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    mkdirSync(join(root, ".openclaw"));
    const fsync = vi.spyOn(fs, "fsyncSync");
    syncBuiltinESMExports();
    try {
      const manager = SettingsManager.create(root, agentDir);
      expect(manager.drainErrors()).toEqual([]);
      expect(manager.getGlobalSettings()).toEqual({});
      expect(manager.getProjectSettings()).toEqual({});
      expect(fsync).not.toHaveBeenCalled();
    } finally {
      fsync.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it.each(["global", "project"] as const)(
    "reads committed %s settings from an already-owned first write",
    (scope) =>
      fixtures.run(async () => {
        const root = fixtures.createTempDir("openclaw-settings-first-writer-");
        const agentDir = join(root, "agent");
        const settingsDir = scope === "global" ? agentDir : join(root, ".openclaw");
        const settingsPath = join(settingsDir, "settings.json");
        const readyPath = join(root, "writer-ready");
        const continuePath = join(root, "writer-continue");
        const committedPath = join(root, "writer-committed");
        mkdirSync(settingsDir);
        const abort = new AbortController();
        const writer = fixtures.track(
          runNodeScript(
            [
              "--import",
              new URL("../../../scripts/tsx.mjs", import.meta.url).href,
              "--input-type=module",
              "--eval",
              String.raw`
                import { existsSync, writeFileSync } from "node:fs";
                const [moduleUrl, root, agentDir, scope, readyPath, continuePath, committedPath] = process.argv.slice(1);
                const { FileSettingsStorage } = await import(moduleUrl);
                new FileSettingsStorage(root, agentDir).withLock(scope, (current) => {
                  if (current !== undefined) throw new Error("first-writer fixture already has settings");
                  writeFileSync(readyPath, "ready");
                  const deadline = Date.now() + 5_000;
                  const pause = new Int32Array(new SharedArrayBuffer(4));
                  while (!existsSync(continuePath)) {
                    if (Date.now() >= deadline) throw new Error("missing reader signal");
                    Atomics.wait(pause, 0, 0, 2);
                  }
                  return JSON.stringify({ theme: scope + "-committed" });
                });
                writeFileSync(committedPath, "committed");
              `,
              new URL("./settings-storage.ts", import.meta.url).href,
              root,
              agentDir,
              scope,
              readyPath,
              continuePath,
              committedPath,
            ],
            process.env,
            10_000,
            { signal: abort.signal, requireProcessTreeExit: true },
          ),
        );
        const originalExists = fs.existsSync;
        let committedDuringRead = false;
        try {
          await Promise.race([
            waitForFile(readyPath, 10_000),
            writer.then((result) => {
              throw new Error(`first writer exited before its reader: ${result.stderr}`);
            }),
          ]);
          expect(existsSync(settingsPath)).toBe(false);
          expect(existsSync(`${settingsPath}.lock`)).toBe(true);
          // Return the real observation, but let the independently locked writer
          // commit before the next probe. File-first probing then returns stale defaults.
          vi.spyOn(fs, "existsSync").mockImplementation((filePath) => {
            const observed = originalExists(filePath);
            if (!committedDuringRead && (filePath === settingsPath || filePath === settingsDir)) {
              committedDuringRead = true;
              fs.writeFileSync(continuePath, "continue");
              const deadline = Date.now() + 5_000;
              const pause = new Int32Array(new SharedArrayBuffer(4));
              while (!originalExists(committedPath)) {
                if (Date.now() >= deadline) {
                  throw new Error("first writer did not commit");
                }
                Atomics.wait(pause, 0, 0, 2);
              }
            }
            return observed;
          });
          syncBuiltinESMExports();

          const manager = SettingsManager.create(root, agentDir);
          expect(committedDuringRead).toBe(true);
          expect(manager.drainErrors()).toEqual([]);
          expect(manager.getTheme()).toBe(`${scope}-committed`);
          expect(await writer).toMatchObject({ error: undefined, status: 0 });
          expect(existsSync(`${settingsPath}.lock`)).toBe(false);
        } finally {
          vi.restoreAllMocks();
          syncBuiltinESMExports();
          abort.abort();
          await writer;
        }
      }),
    20_000,
  );

  it.each([".lock", ".lock.reclaim"])(
    "does not skip an existing %s namespace when settings are absent",
    (suffix) => {
      const root = fixtures.createTempDir("openclaw-settings-lock-namespace-");
      const settingsDir = join(root, "agent");
      mkdirSync(settingsDir);
      mkdirSync(join(settingsDir, `settings.json${suffix}`));
      const storage = new FileSettingsStorage(root, settingsDir);
      expect(() => storage.readSettingsScope("global")).toThrow(
        suffix === ".lock" ? /Legacy storage lock/ : /file lock timeout/,
      );
    },
  );

  it.skipIf(process.platform === "win32")("does not skip a dangling lock symlink", () => {
    const root = fixtures.createTempDir("openclaw-settings-lock-symlink-");
    const settingsDir = join(root, "agent");
    mkdirSync(settingsDir);
    fs.symlinkSync(join(root, "missing"), join(settingsDir, "settings.json.lock"));
    expect(() => new FileSettingsStorage(root, settingsDir).readSettingsScope("global")).toThrow(
      /unsupported legacy type/,
    );
  });

  it("locks before reading when the settings directory exists", () => {
    const root = fixtures.createTempDir("openclaw-settings-lock-");
    const settingsDir = join(root, "agent");
    const settingsPath = join(settingsDir, "settings.json");
    mkdirSync(settingsDir);
    const storage = new FileSettingsStorage(settingsDir, settingsDir);
    let lockedDuringRead = false;

    storage.withLock("global", (current) => {
      lockedDuringRead = existsSync(`${settingsPath}.lock`);
      expect(current).toBeUndefined();
      return undefined;
    });

    expect(lockedDuringRead).toBe(true);
    expect(existsSync(settingsPath)).toBe(false);
  });

  it("creates a missing directory when the callback writes", () => {
    const root = fixtures.createTempDir("openclaw-settings-write-");
    const settingsDir = join(root, "agent");
    const settingsPath = join(settingsDir, "settings.json");
    const storage = new FileSettingsStorage(settingsDir, settingsDir);

    storage.withLock("global", () => JSON.stringify({ theme: "dark" }));

    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ theme: "dark" });
  });
});
