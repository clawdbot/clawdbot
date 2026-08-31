import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { waitForDead } from "../helpers/process-wait.js";

const fixture = createFixtureLifetime();
afterEach(() => fixture.cleanup());
const sourceRoot = process.cwd();
const declarationPath = "dist/plugin-sdk/src/plugin-sdk/qa-channel-protocol.d.ts";
const tsgoArgs = ["-p", "tsconfig.plugin-sdk.dts.json", "--declaration", "true"];
const buildArgs = ["--config", "fixture.tsdown.config.ts", "--out-dir", "dist"];

function write(root: string, relative: string, content: string) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function createCheckout() {
  const root = fs.realpathSync(fixture.createTempDir("openclaw-dist-owner-"));
  write(root, "package.json", '{"type":"module"}');
  write(root, "pnpm-workspace.yaml", "packages: []\n");
  write(root, "src/plugin-sdk/qa-channel-protocol.ts", "export interface Channel { id: string }\n");
  write(
    root,
    "tsconfig.plugin-sdk.dts.json",
    JSON.stringify({
      compilerOptions: {
        declaration: true,
        emitDeclarationOnly: true,
        rootDir: ".",
        outDir: "dist/plugin-sdk",
        incremental: true,
        tsBuildInfoFile: "dist/plugin-sdk/.tsbuildinfo",
        types: [],
        module: "esnext",
        target: "es2022",
        skipLibCheck: true,
      },
      files: ["src/plugin-sdk/qa-channel-protocol.ts"],
    }),
  );
  return root;
}

function installCompiler(root: string, afterEmit = "") {
  const compiler = write(
    root,
    "node_modules/.bin/tsgo",
    `#!/usr/bin/env node
    const { spawnSync } = require('node:child_process');
    console.error('[fixture tsgo] starting', ...process.argv.slice(2));
    const result = spawnSync(process.execPath, [${JSON.stringify(path.join(sourceRoot, "node_modules/@typescript/native-preview/bin/tsgo"))}, ...process.argv.slice(2)], { stdio: 'inherit' });
    console.error('[fixture tsgo] finished', result.status, result.signal);
    if (result.status !== 0) process.exit(result.status ?? 1);
    ${afterEmit}
  `,
  );
  fs.chmodSync(compiler, 0o755);
}

function installBuildCheckpoint(root: string, checkpoint: string) {
  // Both build launch paths must reach the fixture's same completion barrier.
  write(
    root,
    "node_modules/tsdown/dist/run.mjs",
    `import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    ${checkpoint}`,
  );
  write(root, "pnpm.cjs", 'import("./node_modules/tsdown/dist/run.mjs");\n');
}

function installScripts(root: string, scripts: string[]) {
  for (const script of scripts) {
    write(
      root,
      `scripts/${script}`,
      fs.readFileSync(path.join(sourceRoot, "scripts", script), "utf8"),
    );
  }
  fs.mkdirSync(path.join(root, "scripts/lib"), { recursive: true });
  for (const entry of fs.readdirSync(path.join(sourceRoot, "scripts/lib"))) {
    if (entry === "plugin-sdk-entrypoints.json") {
      continue;
    }
    if (entry === "plugin-sdk-entries.mts") {
      fs.copyFileSync(
        path.join(sourceRoot, "scripts/lib", entry),
        path.join(root, "scripts/lib", entry),
      );
    } else {
      fs.symlinkSync(
        path.join(sourceRoot, "scripts/lib", entry),
        path.join(root, "scripts/lib", entry),
      );
    }
  }
  write(root, "scripts/lib/plugin-sdk-entrypoints.json", '["qa-channel-protocol"]');
  fs.symlinkSync(
    path.join(sourceRoot, "scripts/windows-cmd-helpers.mjs"),
    path.join(root, "scripts/windows-cmd-helpers.mjs"),
  );
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  for (const name of ["tsx", "typescript", "@typescript", "@openclaw/fs-safe"]) {
    fs.mkdirSync(path.dirname(path.join(root, "node_modules", name)), { recursive: true });
    fs.symlinkSync(
      path.join(sourceRoot, "node_modules", name),
      path.join(root, "node_modules", name),
    );
  }
}

function withProcesses(...args: Parameters<typeof runWithProcesses>) {
  return fixture.run(() => runWithProcesses(...args));
}

async function runWithProcesses(
  run: (fixture: {
    checkpoint: (name: string) => string;
    waitEvent: (name: string) => Promise<net.Socket>;
    start: (
      root: string,
      script: string,
      args?: string[],
    ) => {
      waiting: Promise<void>;
      done: Promise<{ code: unknown; output: string }>;
      event: (name: string) => Promise<net.Socket>;
    };
  }) => Promise<void>,
  signal: AbortSignal,
) {
  const sockets = new Set<net.Socket>();
  const events = new Map<string, net.Socket>();
  const checkpointPids = new Set<number>();
  const listeners = new Map<string, (socket: net.Socket) => void>();
  let cleaning = false;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    if (cleaning) {
      socket.end("continue");
    }
    socket.once("data", (data) => {
      const { name: event, pid } = JSON.parse(data.toString());
      checkpointPids.add(pid);
      events.set(event, socket);
      listeners.get(event)?.(socket);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing fixture port");
  }
  const children: ReturnType<typeof spawn>[] = [];
  const completions: Promise<unknown>[] = [];
  const diagnostics: (() => string)[] = [];
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () =>
    (cleanupPromise ??= fixture.verifyCleanup(async () => {
      cleaning = true;
      for (const socket of sockets) {
        socket.end("continue");
      }
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
        }
      }
      await Promise.allSettled(completions);
      // Crash cases deliberately orphan a compiler; its barrier closes before
      // process exit. Join that process too before deleting the fixture.
      const orphans = await Promise.allSettled(
        [...checkpointPids].map((pid) => waitForDead(pid, 2_000)),
      );
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      const failures = orphans.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length) {
        throw new AggregateError(failures, "Fixture orphan cleanup unverified");
      }
    }));
  const abort = () => {
    void cleanup().catch((error: unknown) => console.error(error));
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) {
    abort();
  }
  const waitEvent = (name: string) =>
    new Promise<net.Socket>((resolve, reject) => {
      signal.throwIfAborted();
      signal.addEventListener(
        "abort",
        () => reject(new Error("Fixture canceled", { cause: signal.reason })),
        { once: true },
      );
      const socket = events.get(name);
      if (socket) {
        resolve(socket);
      } else {
        listeners.set(name, resolve);
      }
    });
  try {
    await run({
      checkpoint: (name) => `
        const socket = require('node:net').connect(${address.port}, '127.0.0.1', () => socket.write(JSON.stringify({ name: ${JSON.stringify(name)}, pid: process.pid })));
        socket.on('data', () => socket.end());
      `,
      waitEvent,
      start: (root, script, args = []) => {
        signal.throwIfAborted();
        const child = spawn(process.execPath, [script, ...args], {
          cwd: root,
          env: { ...process.env, npm_execpath: path.join(root, "pnpm.cjs") },
          stdio: ["ignore", "pipe", "pipe"],
        });
        children.push(child);
        let output = "";
        diagnostics.push(() => `[fixture ${root}] ${script} ${args.join(" ")}\n${output}`);
        let announceWait!: () => void;
        const waiting = new Promise<void>((resolve) => {
          announceWait = resolve;
        });
        child.stdout?.on("data", (data) => {
          output += data;
        });
        child.stderr?.on("data", (data) => {
          output += data;
          if (output.includes("waiting for")) {
            announceWait();
          }
        });
        child.once("error", (error) => {
          output += String(error);
        });
        const done = new Promise<{ code: number | null; output: string }>((resolve) => {
          child.once("close", (code) => resolve({ code, output }));
        });
        completions.push(done);
        return {
          waiting,
          done,
          event: (name) =>
            Promise.race([
              waitEvent(name),
              done.then((result) => {
                throw new Error(`Command exited before ${name}: ${JSON.stringify(result)}`);
              }),
            ]),
        };
      },
    });
  } catch (error) {
    console.error(diagnostics.map((read) => read()).join("\n"));
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    await cleanup();
  }
}

// Native TypeScript emits the declarations. Only
// process completion is gated; ordering never depends on sleeps or host speed.
describe.skipIf(process.platform === "win32")("dist artifact ownership", () => {
  it.for([
    { script: "prepare-extension-package-boundary-artifacts.mts", failStagingCleanup: false },
    { script: "write-plugin-sdk-entry-dts.ts", failStagingCleanup: false },
    { script: "write-plugin-sdk-entry-dts.ts", failStagingCleanup: true },
  ])(
    "retains nested $script cleanup metadata (staging cleanup failure=$failStagingCleanup)",
    async ({ script, failStagingCleanup }, { signal }) => {
      await withProcesses(async ({ start }) => {
        const root = createCheckout();
        installScripts(root, [script, "run-tsgo.mts"]);
        fs.mkdirSync(path.join(root, "packages"), { recursive: true });
        fs.symlinkSync(
          path.join(sourceRoot, "packages/normalization-core"),
          path.join(root, "packages/normalization-core"),
        );
        const scriptUrl = pathToFileURL(path.join(root, "scripts", script)).href;
        const moduleUrl = (name: string) =>
          pathToFileURL(path.join(sourceRoot, "scripts/lib", name)).href;
        const failure = `throw new AggregateError([new Error('child failed', { cause: Object.assign(new Error('cleanup unverified'), { processTreeState: 'indeterminate' }) })], 'fixture failure');`;
        const replacements = {
          "./lib/extension-boundary-inputs.mts": `export * from ${JSON.stringify(moduleUrl("extension-boundary-inputs.mts"))}; export class BoundaryInputSnapshot { constructor() { ${failure} } }`,
          "../tsdown.config.ts": `export default ['openclaw-dts-plugin-sdk-1', 'openclaw-dts-plugin-sdk-2'].map(name => ({ name, dts: { entry: ['fixture.ts'] }, entry: { 'plugin-sdk/fixture': 'fixture.ts' } }));`,
          "./tsdown-build.mts": `export * from ${JSON.stringify(pathToFileURL(path.join(sourceRoot, "scripts/tsdown-build.mts")).href)}; export const prepareTsdownBuildExecution = () => ({});`,
          "./lib/declaration-stage.mts": `export async function publishStagedDeclarations() { ${failure} }`,
        };
        const hook = write(
          root,
          "failure-hook.mjs",
          `
          import fs from 'node:fs';
          import { registerHooks } from 'node:module';
          if (${failStagingCleanup}) {
            const remove = fs.rmSync;
            fs.rmSync = (file, ...args) => {
              if (String(file).startsWith(${JSON.stringify(path.join(root, ".artifacts/plugin-sdk-staging-"))})) throw new Error('fixture staging cleanup failure');
              return remove(file, ...args);
            };
          }
          const replacements = ${JSON.stringify(replacements)};
          registerHooks({ resolve(specifier, context, next) {
            if (context.parentURL === ${JSON.stringify(scriptUrl)} && Object.hasOwn(replacements, specifier)) {
              return { url: 'data:text/javascript,' + encodeURIComponent(replacements[specifier]), shortCircuit: true };
            }
            return next(specifier, context);
          }});
        `,
        );
        const runner = write(
          root,
          "runner.mts",
          `
          import { withDistArtifactOwnership, distArtifactEntryArgs } from ${JSON.stringify(moduleUrl("dist-artifact-ownership.mts"))};
          import { runManagedCommand } from ${JSON.stringify(moduleUrl("managed-child-process.mts"))};
          process.exitCode = await withDistArtifactOwnership(process.cwd(), () => runManagedCommand({
            bin: process.execPath,
            args: ['--import', ${JSON.stringify(pathToFileURL(hook).href)}, ...distArtifactEntryArgs(${JSON.stringify(path.join(root, "scripts", script))})],
            requireProcessTreeExit: true,
          }));
        `,
        );
        const result = await start(root, runner).done;
        expect(result.code, result.output).toBe(1);
        expect(result.output).toContain("fixture failure");
        if (failStagingCleanup) {
          expect(result.output).toContain("fixture staging cleanup failure");
        }
        expect(fs.existsSync(path.join(root, ".artifacts/dist-artifacts.lock/owner.json"))).toBe(
          true,
        );
        expect(fs.existsSync(path.join(root, ".artifacts/dist-artifacts.lock/unjoined"))).toBe(
          true,
        );
        expect(
          fs
            .readdirSync(path.join(root, ".artifacts"))
            .filter((name) => name.startsWith("plugin-sdk-staging-")),
        ).toHaveLength(failStagingCleanup ? 1 : 0);
      }, signal);
    },
  );
  it.for([
    { owner: "{", unjoined: false },
    { owner: '{"pid":0}', unjoined: false },
    { owner: '{"pid":-1}', unjoined: false },
    { owner: '{"pid":2147483648}', unjoined: false },
    { owner: JSON.stringify({ pid: process.pid }), unjoined: true },
  ])(
    "rejects unverifiable or retained ownership without removing it: $owner/$unjoined",
    async ({ owner, unjoined }, { signal }) => {
      await withProcesses(async ({ start }) => {
        const root = createCheckout();
        const ownerPath = write(root, ".artifacts/dist-artifacts.lock/owner.json", owner);
        if (unjoined) {
          write(root, ".artifacts/dist-artifacts.lock/unjoined", "unverified cleanup");
        }
        const command = start(root, path.join(sourceRoot, "scripts/run-tsgo.mjs"), ["--version"]);
        const result = await command.done;
        expect(result.code).toBe(1);
        expect(result.output).toContain("Could not acquire");
        expect(result.output.trim().split("\n").at(-1)).toBe("[tsgo] FAILED (exit 1)");
        expect(fs.readFileSync(ownerPath, "utf8")).toBe(owner);
      }, signal);
    },
  );

  it("acquires after a released owner exits during the liveness probe", async ({ signal }) => {
    await withProcesses(async ({ start }) => {
      const root = createCheckout();
      const ownerPath = write(
        root,
        ".artifacts/dist-artifacts.lock/owner.json",
        JSON.stringify({ pid: process.pid }),
      );
      const probe = write(
        root,
        "handoff.mts",
        `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import { withDistArtifactOwnership } from ${JSON.stringify(path.join(sourceRoot, "scripts/lib/dist-artifact-ownership.mts"))};
        const kill = process.kill;
        // Release after fs-safe observes contention, just before the PID probe.
        process.kill = (pid, signal) => {
          assert.equal(pid, ${process.pid});
          assert.equal(signal, 0);
          fs.unlinkSync(${JSON.stringify(ownerPath)});
          throw Object.assign(new Error('owner exited after releasing'), { code: 'ESRCH' });
        };
        try {
          await withDistArtifactOwnership(process.cwd(), async () => console.log('successor acquired'));
        } finally { process.kill = kill; }
      `,
      );
      const result = await start(root, probe).done;
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain("successor acquired");
      expect(fs.existsSync(ownerPath)).toBe(false);
    }, signal);
  });

  it.for([
    { directory: ".", nested: false },
    { directory: "src", nested: false },
    { directory: "src", nested: true },
    { directory: "linked-src", nested: true },
  ])(
    "keeps declarations alive from $directory (nested=$nested) until their writer joins and keeps ownership across dist cleanup",
    { timeout: 30_000 },
    async ({ directory, nested }, { signal }) => {
      await withProcesses(async ({ checkpoint, waitEvent, start }) => {
        const root = createCheckout();
        const cwd = path.join(root, directory);
        if (directory === "linked-src") {
          fs.symlinkSync(path.join(root, "src"), cwd);
        }
        installCompiler(root, checkpoint("declarations-ready"));
        if (directory !== ".") {
          fs.symlinkSync(path.join(root, "node_modules"), path.join(cwd, "node_modules"));
        }
        installBuildCheckpoint(root, checkpoint("build-started"));
        const writerArgs = [
          "-p",
          path.join(root, "tsconfig.plugin-sdk.dts.json"),
          "--declaration",
          "true",
        ];
        const compilerScript = path.join(sourceRoot, "scripts/run-tsgo.mts");
        const writerScript = nested
          ? write(
              root,
              "nested-writer.mts",
              `
          import { withDistArtifactOwnership, distArtifactEntryArgs } from ${JSON.stringify(path.join(sourceRoot, "scripts/lib/dist-artifact-ownership.mts"))};
          import { runManagedCommand } from ${JSON.stringify(path.join(sourceRoot, "scripts/lib/managed-child-process.mts"))};
          await withDistArtifactOwnership(${JSON.stringify(cwd)}, () => runManagedCommand({
            bin: process.execPath, args: distArtifactEntryArgs(${JSON.stringify(compilerScript)}, ${JSON.stringify(writerArgs)}), requireProcessTreeExit: true,
          }));
        `,
            )
          : compilerScript;
        const writer = start(cwd, writerScript, nested ? [] : writerArgs);
        const writerGate = await writer.event("declarations-ready");
        const declaration = path.join(root, declarationPath);
        expect(fs.readFileSync(declaration, "utf8")).toContain("interface Channel");

        // Advance the contender's wall clock past the observed sixteen-minute build
        // without spending that time in Vitest; restore it before executing tsdown.
        const contender = write(
          root,
          "contender.mts",
          `
        import { withDistArtifactOwnership } from ${JSON.stringify(path.join(sourceRoot, "scripts/lib/dist-artifact-ownership.mts"))};
        import { runTsdownBuild } from ${JSON.stringify(path.join(sourceRoot, "scripts/tsdown-build.mts"))};
        const now = Date.now;
        let reads = 0;
        Date.now = () => now() + reads++ * 16 * 60 * 1000;
        process.exitCode = await withDistArtifactOwnership(process.cwd(), async () => {
          Date.now = now;
          return await runTsdownBuild(${JSON.stringify(buildArgs)});
        });
      `,
        );
        const build = start(root, contender);
        await Promise.race([build.waiting, waitEvent("build-started"), build.done]);
        // Before the repair the real tsdown cleanup deletes the emitted file here.
        expect(
          fs.existsSync(declaration),
          "cleanup must wait for the active declaration writer",
        ).toBe(true);
        writerGate.write("continue");
        expect(await writer.done).toMatchObject({ code: 0 });
        const buildGate = await build.event("build-started");
        expect(fs.existsSync(declaration)).toBe(false);

        installCompiler(root, checkpoint("next-declarations-ready"));
        const nextWriter = start(root, path.join(sourceRoot, "scripts/run-tsgo.mts"), tsgoArgs);
        await Promise.race([
          nextWriter.waiting,
          waitEvent("next-declarations-ready"),
          nextWriter.done,
        ]);
        expect(fs.existsSync(declaration), "deleting dist must not delete build ownership").toBe(
          false,
        );

        const otherRoot = createCheckout();
        installCompiler(otherRoot, checkpoint("other-checkout-ready"));
        const independent = start(
          otherRoot,
          path.join(sourceRoot, "scripts/run-tsgo.mts"),
          tsgoArgs,
        );
        (await independent.event("other-checkout-ready")).write("continue");
        expect(await independent.done).toMatchObject({ code: 0 });
        expect(fs.existsSync(declaration)).toBe(false);

        buildGate.write("continue");
        expect(await build.done).toMatchObject({ code: 0 });
        (await nextWriter.event("next-declarations-ready")).write("continue");
        expect(await nextWriter.done).toMatchObject({ code: 0 });
        expect(fs.readFileSync(declaration, "utf8")).toContain("interface Channel");
      }, signal);
    },
  );

  it("retains ownership when a supervisor exits before its compiler joins", async ({ signal }) => {
    await withProcesses(async ({ checkpoint, waitEvent, start }) => {
      const root = createCheckout();
      installCompiler(
        root,
        `require('node:fs').writeFileSync('compiler.pid', String(process.pid)); ${checkpoint("orphan-ready")}`,
      );
      installBuildCheckpoint(root, checkpoint("orphan-build-started"));
      const owner = write(
        root,
        "owner.mts",
        [
          `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);`,
          checkpoint("exit-owner"),
          `socket.on('data', () => process.exit(2));`,
          `process.argv = [process.execPath, ${JSON.stringify(path.join(sourceRoot, "scripts/run-tsgo.mts"))}, ...${JSON.stringify(tsgoArgs)}];`,
          `await import(${JSON.stringify(path.join(sourceRoot, "scripts/run-tsgo.mts"))});`,
        ].join("\n"),
      );
      const supervisor = start(root, owner);
      const compilerGate = await supervisor.event("orphan-ready");
      const compilerPid = Number(fs.readFileSync(path.join(root, "compiler.pid"), "utf8"));
      (await waitEvent("exit-owner")).write("exit");
      expect(await supervisor.done).toMatchObject({ code: 2 });
      const build = start(root, path.join(sourceRoot, "scripts/tsdown-build.mts"), buildArgs);
      await Promise.race([build.waiting, waitEvent("orphan-build-started"), build.done]);
      expect(
        fs.existsSync(path.join(root, declarationPath)),
        "exit hooks must not release an active compiler's output",
      ).toBe(true);
      expect(await build.done).toMatchObject({
        code: 1,
        output: expect.stringContaining("PID death alone is not sufficient."),
      });
      expect(fs.existsSync(path.join(root, ".artifacts/dist-artifacts.lock/owner.json"))).toBe(
        true,
      );
      compilerGate.write("continue");
      await waitForDead(compilerPid, 2_000);
    }, signal);
  }, 30_000);

  it("retains ownership when a nested wrapper dies before its detached compiler joins", async ({
    signal,
  }) => {
    await withProcesses(async ({ checkpoint, waitEvent, start }) => {
      const root = createCheckout();
      installCompiler(
        root,
        `require('node:fs').writeFileSync('compiler.json', JSON.stringify({ pid: process.pid, wrapper: process.ppid })); ${checkpoint("nested-compiler-ready")}`,
      );
      fs.symlinkSync(
        path.join(sourceRoot, "node_modules/tsx"),
        path.join(root, "node_modules/tsx"),
      );
      installBuildCheckpoint(root, checkpoint("nested-build-started"));
      const owner = write(
        root,
        "owner.mts",
        [
          `import { withDistArtifactOwnership, distArtifactEntryArgs } from ${JSON.stringify(path.join(sourceRoot, "scripts/lib/dist-artifact-ownership.mts"))};`,
          `import { runManagedCommand } from ${JSON.stringify(path.join(sourceRoot, "scripts/lib/managed-child-process.mts"))};`,
          `await withDistArtifactOwnership(process.cwd(), () => runManagedCommand({`,
          `bin: process.execPath, args: distArtifactEntryArgs(${JSON.stringify(path.join(sourceRoot, "scripts/run-tsgo.mts"))}, ${JSON.stringify(tsgoArgs)}), requireProcessTreeExit: true }));`,
        ].join("\n"),
      );
      const supervisor = start(root, owner);
      const compilerGate = await supervisor.event("nested-compiler-ready");
      const compiler = JSON.parse(fs.readFileSync(path.join(root, "compiler.json"), "utf8"));
      try {
        process.kill(compiler.wrapper, "SIGKILL");
        await supervisor.done;
        const build = start(root, path.join(sourceRoot, "scripts/tsdown-build.mts"), buildArgs);
        await Promise.race([build.waiting, waitEvent("nested-build-started"), build.done]);
        expect(
          fs.existsSync(path.join(root, declarationPath)),
          "a killed nested wrapper cannot certify compiler completion",
        ).toBe(true);
      } finally {
        compilerGate.write("continue");
        await waitForDead(compiler.pid, 2_000);
      }
    }, signal);
  }, 30_000);

  it("preserves compiler shard concurrency inside one checkout owner", async ({ signal }) => {
    await withProcesses(async ({ checkpoint, waitEvent, start }) => {
      const root = createCheckout();
      installScripts(root, ["run-tsgo-core-test-shards.mts", "run-tsgo.mts"]);
      const compiler = write(
        root,
        "node_modules/.bin/tsgo",
        `#!/usr/bin/env node
        if (process.argv.some(arg => arg.endsWith('tsconfig.core.test.ui-pages.json'))) { ${checkpoint("shard-pages")} }
        else if (process.argv.some(arg => arg.endsWith('tsconfig.core.test.ui-e2e.json'))) { ${checkpoint("shard-e2e")} }
      `,
      );
      fs.chmodSync(compiler, 0o755);
      installBuildCheckpoint(root, checkpoint("shard-build-started"));
      write(root, "dist/still-consumed.txt", "owned");
      const shards = start(root, path.join(root, "scripts/run-tsgo-core-test-shards.mts"), [
        "ui",
        "--concurrency",
        "2",
      ]);
      const [pages, e2e] = await Promise.all([
        shards.event("shard-pages"),
        shards.event("shard-e2e"),
      ]);
      const build = start(root, path.join(sourceRoot, "scripts/tsdown-build.mts"), buildArgs);
      await Promise.race([build.waiting, waitEvent("shard-build-started"), build.done]);
      expect(fs.existsSync(path.join(root, "dist/still-consumed.txt"))).toBe(true);
      pages.write("continue");
      e2e.write("continue");
      expect(await shards.done).toMatchObject({ code: 0 });
      (await build.event("shard-build-started")).write("continue");
      expect(await build.done).toMatchObject({ code: 0 });
    }, signal);
  }, 30_000);

  it("holds real native declaration preparation through lint consumption and canonical cleanup", async ({
    signal,
  }) => {
    await withProcesses(async ({ checkpoint, waitEvent, start }) => {
      const root = createCheckout();
      installCompiler(root);
      // Entrypoints resolve this fixture as their checkout; the compiler graph
      // contains one SDK interface and one source per required preparation lane.
      installScripts(root, [
        "run-oxlint.mts",
        "run-tsgo.mts",
        "prepare-extension-package-boundary-artifacts.mts",
      ]);
      for (const name of ["normalization-core", "acp-core", "ai"]) {
        fs.mkdirSync(path.join(root, "packages"), { recursive: true });
        fs.symlinkSync(path.join(sourceRoot, "packages", name), path.join(root, "packages", name));
      }
      write(root, "tsconfig.json", "{}");
      write(
        root,
        "packages/plugin-sdk/tsconfig.json",
        JSON.stringify({
          extends: "../../tsconfig.plugin-sdk.dts.json",
          compilerOptions: { outDir: "dist", tsBuildInfoFile: "dist/.tsbuildinfo" },
        }),
      );
      for (const name of [
        "qa-channel",
        "memory-core",
        "matrix",
        "discord",
        "slack",
        "telegram",
        "whatsapp",
      ]) {
        const entry = name === "matrix" ? "test-api.ts" : "api.ts";
        write(root, `extensions/${name}/${entry}`, "export interface Plugin { id: string }\n");
        write(
          root,
          `extensions/${name}/tsconfig.json`,
          JSON.stringify({ compilerOptions: { types: [] }, files: [entry] }),
        );
      }
      const lint = write(
        root,
        "node_modules/.bin/oxlint",
        `#!/usr/bin/env node
        const fs = require('node:fs');
        const sdk = 'packages/plugin-sdk/dist/src/plugin-sdk/qa-channel-protocol.d.ts';
        if (!fs.readFileSync(sdk, 'utf8').includes('interface Channel')) process.exit(2);
        if (!fs.readFileSync('.artifacts/extension-package-boundary/plugins/qa-channel/api.d.ts', 'utf8').includes('interface Plugin')) process.exit(3);
        ${checkpoint("lint-consuming")}
      `,
      );
      fs.chmodSync(lint, 0o755);
      write(root, "dist/still-consumed.txt", "owned by lint");
      installBuildCheckpoint(root, checkpoint("lint-build-started"));
      const consumer = start(root, path.join(root, "scripts/run-oxlint.mts"), [
        "--tsconfig",
        "extensions/tsconfig.json",
        "extensions",
      ]);
      const ready = await consumer.event("lint-consuming");
      expect(
        fs.readFileSync(
          path.join(root, "packages/plugin-sdk/dist/src/plugin-sdk/qa-channel-protocol.d.ts"),
          "utf8",
        ),
      ).toContain("interface Channel");
      expect(
        fs.readFileSync(
          path.join(root, ".artifacts/extension-package-boundary/plugins/qa-channel/api.d.ts"),
          "utf8",
        ),
      ).toContain("interface Plugin");
      const build = start(root, path.join(sourceRoot, "scripts/tsdown-build.mts"), buildArgs);
      await Promise.race([build.waiting, waitEvent("lint-build-started"), build.done]);
      expect(
        fs.existsSync(path.join(root, "dist/still-consumed.txt")),
        "cleanup must wait through dependent lint",
      ).toBe(true);
      ready.write("continue");
      expect(await consumer.done).toMatchObject({ code: 0 });
      (await build.event("lint-build-started")).write("continue");
      expect(await build.done).toMatchObject({ code: 0 });
      expect(fs.existsSync(path.join(root, "dist/still-consumed.txt"))).toBe(false);
      expect(
        fs.readFileSync(
          path.join(root, "packages/plugin-sdk/dist/src/plugin-sdk/qa-channel-protocol.d.ts"),
          "utf8",
        ),
      ).toContain("interface Channel");
    }, signal);
  }, 30_000);
});
