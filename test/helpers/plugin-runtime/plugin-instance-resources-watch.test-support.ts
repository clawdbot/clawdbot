import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import type { PluginInstance } from "../../../src/plugins/plugin-instance.js";

const require = createRequire(import.meta.url);

export async function verifyWatchLifecycle(
  scenario: string,
  instance: PluginInstance,
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-owned-watch-"));
  const filename = path.join(root, "watched");
  fs.writeFileSync(filename, "initial");
  const cwd = process.cwd();
  try {
    const owned = instance.loadBuiltin("node:fs", require) as typeof fs;
    if (scenario.startsWith("promise-watch-")) {
      const promises = scenario.includes("namespace")
        ? owned.promises
        : (instance.loadBuiltin("node:fs/promises", require) as typeof fs.promises);
      if (scenario.endsWith("validation")) {
        let reads = 0;
        const invalid = Reflect.apply(promises.watch, promises, [
          filename,
          {
            get signal() {
              reads += 1;
              return null;
            },
          },
        ]);
        assert.equal(reads, 0, "watch eagerly read lazy native options");
        await assert.rejects(invalid.next(), { code: "ERR_INVALID_ARG_TYPE" });
        assert.equal(reads, 1);
        return;
      }
      const external = new AbortController();
      const reason = new Error("caller cancelled watcher");
      const iterator = promises.watch(filename, Object.freeze({ signal: external.signal }));
      const pending = iterator.next();
      let completed = false;
      const settled = assert
        .rejects(pending, (error: unknown) => {
          assert.ok(error && typeof error === "object");
          assert.equal(Reflect.get(error, "name"), "AbortError");
          assert.equal(
            Reflect.get(error, "cause"),
            scenario.endsWith("external") ? reason : instance.lifecycle.signal.reason,
          );
          return true;
        })
        .finally(() => {
          completed = true;
        });
      try {
        await yieldImmediate();
        if (scenario.endsWith("external")) {
          external.abort(reason);
        } else {
          await instance.dispose();
        }
        await yieldImmediate();
        assert.equal(completed, true, "retirement did not settle the pending native watch");
        await settled;
        assert.deepEqual(await iterator.next(), { value: undefined, done: true });
      } finally {
        external.abort(scenario.endsWith("external") ? reason : instance.lifecycle.signal.reason);
        await settled;
        await iterator.return?.();
      }
    } else if (scenario === "watch-file-invalid-path") {
      for (const api of [fs, owned]) {
        assert.throws(() => api.unwatchFile("bad\0path"), { code: "ERR_INVALID_ARG_VALUE" });
      }
    } else if (scenario.startsWith("watch-file-natural-exit")) {
      if (scenario.endsWith("get-cwd")) {
        process.chdir(root);
        owned.watchFile(
          "watched",
          {
            get interval() {
              process.chdir(cwd);
              return 10;
            },
          },
          () => {},
        );
      } else {
        owned.watchFile(filename, { interval: 10 }, () => {});
      }
      await instance.dispose();
      // The isolated process must exit without a test-side unwatch or forced process.exit.
    } else {
      let calls = 0;
      let siblingCalls = 0;
      const listener = () => {
        calls += 1;
      };
      const sibling = () => {
        siblingCalls += 1;
      };
      const watcher = fs.watchFile(filename, { interval: 10 }, sibling);
      process.chdir(root);
      owned.watchFile("watched", { interval: 10 }, listener);
      if (scenario === "watch-file-unwatch-one") {
        owned.watchFile("watched", { interval: 10 }, listener);
        owned.unwatchFile("watched", listener);
      } else if (scenario === "watch-file-unwatch-all") {
        owned.unwatchFile("watched");
      } else {
        process.chdir(cwd);
        await instance.dispose();
      }
      const before = calls;
      const siblingBefore = siblingCalls;
      const stats = fs.statSync(filename);
      watcher.emit("change", stats, stats);
      assert.equal(calls - before, scenario === "watch-file-unwatch-one" ? 1 : 0);
      assert.equal(siblingCalls - siblingBefore, 1, "another owner's listener was removed");
      assert.notEqual(Reflect.get(watcher, "_handle"), null, "another owner's poller was stopped");
      if (scenario === "watch-file-shared-unref") {
        watcher.unref();
        // Node's ref-count must now allow natural exit with only the caller's unref'ed subscription.
      }
    }
  } finally {
    process.chdir(cwd);
    await instance.dispose();
    if (!scenario.startsWith("watch-file-natural-exit") && scenario !== "watch-file-shared-unref") {
      fs.unwatchFile(filename);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
