import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "tsdown";
import { expect, it } from "vitest";
import { spawnNodeEvalSync } from "../../test-utils/node-process.js";

it("keeps admitted session ownership across native and transformed SDK graphs", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reply-admission-module-")));
  const repo = process.cwd();
  const dist = path.join(root, "dist");
  const source = (relativePath: string) => JSON.stringify(path.join(repo, relativePath));
  const ownerExports = `
    export { admitReplyTurn } from ${source("src/auto-reply/reply/reply-turn-admission.ts")};
    export { replyRunRegistry } from ${source("src/auto-reply/reply/reply-run-registry.ts")};
    export { replaceSessionEntrySync } from ${source("src/config/sessions/session-accessor.ts")};
    export { closeOpenClawAgentDatabases } from ${source("src/state/openclaw-agent-db.ts")};
    export { closeOpenClawStateDatabase } from ${source("src/state/openclaw-state-db.ts")};
  `;
  try {
    fs.mkdirSync(dist);
    fs.symlinkSync(path.join(repo, "node_modules"), path.join(root, "node_modules"), "junction");
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
    fs.writeFileSync(path.join(root, "config.json"), "{}\n");
    fs.writeFileSync(
      path.join(root, "host.ts"),
      `${ownerExports}
       export { getCachedPluginModuleLoader } from ${source("src/plugins/plugin-module-loader-cache.ts")};`,
    );
    fs.writeFileSync(path.join(root, "admission-runtime.ts"), ownerExports);
    fs.writeFileSync(
      path.join(root, "plugin.ts"),
      'export * from "openclaw/plugin-sdk/admission-fixture";\n',
    );
    // Model the packaged host/SDK graph, then load a plugin through its supported transform path.
    await build({
      config: false,
      cwd: repo,
      entry: {
        host: path.join(root, "host.ts"),
        "admission-runtime": path.join(root, "admission-runtime.ts"),
      },
      dts: false,
      envPrefix: [],
      clean: false,
      deps: {
        // Match compiled workers: workspace packages bring their private dependencies.
        alwaysBundle: (id) =>
          (id.startsWith("@openclaw/") || id.startsWith("openclaw/")) &&
          id !== "@openclaw/fs-safe" &&
          !id.startsWith("@openclaw/fs-safe/"),
      },
      platform: "node",
      format: "esm",
      outDir: dist,
      outExtensions: () => ({ js: ".js" }),
      tsconfig: path.join(repo, "tsconfig.json"),
      logLevel: "silent",
    });
    for (const schema of ["openclaw-agent-schema.sql", "openclaw-state-schema.sql"]) {
      fs.copyFileSync(path.join(repo, "src/state", schema), path.join(dist, schema));
    }
    const result = spawnNodeEvalSync(
      String.raw`
        import assert from "node:assert/strict";
        import path from "node:path";
        const root = ${JSON.stringify(root)};
        const operations = new Set();
        const outcomes = [];
        let host;
        let transformed;
        const bounded = async (work, label) => {
          let timer;
          try {
            return await Promise.race([
              work,
              new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("Admission probe stalled: " + label)), 5_000);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        };
        try {
          host = await import(${JSON.stringify(pathToFileURL(path.join(dist, "host.js")).href)});
          const native = await import(${JSON.stringify(pathToFileURL(path.join(dist, "admission-runtime.js")).href)});
          assert.equal(native.admitReplyTurn, host.admitReplyTurn, "native SDK shares the host graph");
          const modulePath = path.join(root, "plugin.ts");
          transformed = host.getCachedPluginModuleLoader({
            modulePath, rootDir: root, importerUrl: import.meta.url, tryNative: false,
            transformOpenClawDependencies: true,
            aliasMap: { "openclaw/plugin-sdk/admission-fixture": path.join(root, "dist/admission-runtime.js") },
          })(modulePath);
          assert.notEqual(transformed.admitReplyTurn, host.admitReplyTurn, "transformed SDK evaluates a separate graph");
          const cases = [
            { name: "native-same-store", parent: native, foreign: false },
            { name: "transformed-same-store", parent: transformed, foreign: false },
            { name: "transformed-foreign-store", parent: transformed, foreign: true },
          ];
          for (const scenario of cases) {
            const sessionKey = "global";
            const sessionId = "before-" + scenario.name;
            const successorId = "after-" + scenario.name;
            const caseRoot = path.join(root, "state", scenario.name);
            const targetStore = path.join(caseRoot, "target", "sessions.json");
            const parentStore = scenario.foreign
              ? path.join(caseRoot, "foreign", "sessions.json") : targetStore;
            const write = (storePath, id) => host.replaceSessionEntrySync(
              { storePath, sessionKey }, { sessionId: id, updatedAt: Date.now() },
            );
            write(targetStore, sessionId);
            if (scenario.foreign) write(parentStore, sessionId);
            const admitted = await bounded(scenario.parent.admitReplyTurn({
              sessionKey, sessionId, storePath: parentStore, kind: "visible", resetTriggered: false,
            }), scenario.name + " parent");
            assert.equal(admitted.status, "owned", "parent must hold actual admission");
            const parent = admitted.operation;
            operations.add(parent);
            parent.setPhase("preflight_compacting");
            let enteredWait;
            const waiting = new Promise(resolve => { enteredWait = resolve; });
            const waitForIdle = host.replyRunRegistry.waitForIdle;
            host.replyRunRegistry.waitForIdle = function (...args) {
              const result = waitForIdle.apply(this, args);
              enteredWait();
              return result;
            };
            const controller = new AbortController();
            let child;
            let pending;
            try {
              pending = host.admitReplyTurn({
                sessionKey, sessionId, expectedSessionId: sessionId, storePath: targetStore,
                kind: "queued_followup", resetTriggered: false, waitTimeoutMs: 5_000,
                upstreamAbortSignal: controller.signal,
              });
              void pending.catch(() => {});
              await bounded(waiting, scenario.name + " native waitForIdle");
              write(parentStore, successorId);
              // Equal UUIDs in a separately replaced store cannot prove this parent's ownership.
              if (scenario.foreign) write(targetStore, successorId);
              parent.updateSessionId(successorId);
              parent.complete();
              child = await bounded(pending, scenario.name + " successor");
              if (child.status === "owned") operations.add(child.operation);
              const outcome = child.status === "owned"
                ? { name: scenario.name, status: child.status, sessionId: child.operation.sessionId }
                : { name: scenario.name, status: child.status, reason: child.reason };
              outcomes.push(outcome);
              console.log(JSON.stringify(outcome));
            } finally {
              host.replyRunRegistry.waitForIdle = waitForIdle;
              parent.complete();
              if (child?.status === "owned") child.operation.complete();
              controller.abort();
              if (pending) {
                const unfinished = await bounded(pending, scenario.name + " cleanup").catch(() => undefined);
                if (unfinished?.status === "owned") unfinished.operation.complete();
              }
            }
          }
          assert.deepEqual(outcomes, [
            { name: "native-same-store", status: "owned", sessionId: "after-native-same-store" },
            { name: "transformed-same-store", status: "owned", sessionId: "after-transformed-same-store" },
            { name: "transformed-foreign-store", status: "skipped", reason: "lifecycle-invalidated" },
          ]);
        } finally {
          for (const operation of operations) operation.complete();
          transformed?.closeOpenClawAgentDatabases();
          host?.closeOpenClawAgentDatabases();
          transformed?.closeOpenClawStateDatabase();
          host?.closeOpenClawStateDatabase();
        }
      `,
      {
        timeout: 45_000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: root,
          USERPROFILE: root,
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          OPENCLAW_CONFIG_PATH: path.join(root, "config.json"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          JITI_FS_CACHE: "0",
        },
      },
    );
    expect(
      result.status,
      [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n"),
    ).toBe(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
