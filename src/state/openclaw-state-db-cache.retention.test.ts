import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("releases closed shared database wrappers after path and global retirement", () => {
  const stateDir = tempDirs.make("openclaw-state-retention-");
  const moduleUrl = new URL("./openclaw-state-db.ts", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    import {
      closeOpenClawStateDatabase,
      closeOpenClawStateDatabaseByPath,
      openOpenClawStateDatabase,
    } from ${JSON.stringify(moduleUrl)};

    function retire(byPath) {
      const owner = openOpenClawStateDatabase();
      const ref = new WeakRef(owner.db);
      for (let i = 0; i < 3; i++) {
        assert.equal(openOpenClawStateDatabase(), owner);
      }
      if (byPath) {
        assert.equal(closeOpenClawStateDatabaseByPath(owner.path), true);
      } else {
        closeOpenClawStateDatabase();
      }
      assert.equal(owner.db.isOpen, false);
      return ref;
    }
    const refs = [retire(true), retire(false)];
    for (let i = 0; i < 30; i++) {
      await new Promise(setImmediate);
      globalThis.gc();
    }
    process.stdout.write(JSON.stringify(refs.map(ref => ref.deref() === undefined)));
  `;
  const result = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--expose-gc",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      script,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      encoding: "utf8",
      timeout: 20_000,
    },
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([true, true]);
});
