// Real installed-entry child proof with the old lazy module physically removed.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { UPDATE_RUN_ID_ENV } from "../infra/update-control-plane-sentinel.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
it("retains original JSON and closes the shared lease after preloaded owner files and old lazy chunks are removed", async () => {
  const root = await fs.realpath(dirs.make("triage-rotated-child-"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  const source = path.resolve("src/commands/triage-failure.ts");
  const oldOwner = path.join(root, "triage-failure.mts");
  // Preload the real continuation, adapter and complete lease owner too. Removing them after
  // import protects the old updater's resident graph across package replacement.
  const relocated = new Map([
    [source, oldOwner],
    [path.resolve("src/infra/triage-continuation.ts"), path.join(root, "continuation.mts")],
    [
      path.resolve("src/infra/update-managed-service-handoff-lease.ts"),
      path.join(root, "lease.mts"),
    ],
    ...[
      "src/infra/update-managed-service-handoff-cleanup.ts",
      "src/shared/pid-alive.ts",
      "src/infra/windows-process-start.ts",
      "src/infra/process-env.ts",
      "packages/normalization-core/src/record-coerce.ts",
    ].map((file) => [path.resolve(file), path.join(root, path.basename(file))] as const),
  ]);
  for (const [original, destination] of relocated) {
    const code = (await fs.readFile(original, "utf8")).replace(
      /from "([^"]+)"/g,
      (_match, specifier: string) => {
        const resolved =
          specifier === "@openclaw/normalization-core/record-coerce"
            ? path.resolve("packages/normalization-core/src/record-coerce.ts")
            : specifier.startsWith(".")
              ? path.resolve(path.dirname(original), specifier).replace(/\.js$/, ".ts")
              : undefined;
        if (!resolved) {
          return `from ${JSON.stringify(import.meta.resolve(specifier))}`;
        }
        return `from ${JSON.stringify(pathToFileURL(relocated.get(resolved) ?? resolved).href)}`;
      },
    );
    await fs.writeFile(destination, code);
  }
  await fs.writeFile(
    path.join(root, "triage.js"),
    "export function triageCommand() { throw new Error('old diagnostics'); }",
  );
  const installed = path.join(root, "candidate");
  await fs.mkdir(path.join(installed, "dist"), { recursive: true });
  const receipt = path.join(root, "receipt.json");
  await fs.writeFile(path.join(installed, "package.json"), JSON.stringify({ type: "module" }));
  await fs.writeFile(
    path.join(installed, "dist/index.js"),
    `
import { acceptTriageContinuation } from ${JSON.stringify(pathToFileURL(path.resolve("src/infra/triage-continuation.ts")).href)};
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const admission=await acceptTriageContinuation();
if (!admission) throw new Error('candidate was not admitted');
const descendant=JSON.parse(execFileSync(process.execPath,['-e','console.log(JSON.stringify({updateRunId:process.env[${JSON.stringify(UPDATE_RUN_ID_ENV)}] ?? null,handoff:process.env.OPENCLAW_UPDATE_RUN_HANDOFF ?? null,sentinel:process.env.OPENCLAW_CONTROL_PLANE_UPDATE_SENTINEL_META ?? null,inProgress:process.env.OPENCLAW_UPDATE_IN_PROGRESS ?? null,shell:process.env.OPENCLAW_SHELL,compileCache:process.env.NODE_DISABLE_COMPILE_CACHE}))'],{encoding:'utf8'}));
fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({message:admission,descendant,args:process.argv.slice(2)}));
await admission.finish("closed");
`,
  );
  const runner = path.join(root, "updater.mts");
  await fs.writeFile(
    runner,
    `
import { triageAfterFailure } from ${JSON.stringify(pathToFileURL(oldOwner).href)};
import fs from 'node:fs/promises';
await Promise.all(${JSON.stringify([...relocated.values(), path.join(root, "triage.js")])}.map(file => fs.rm(file)));
process.stdout.write('{"status":"error","reason":"original failure"}\\n');
await triageAfterFailure({log:console.log,error:console.error,exit:()=>{throw new Error('failure owner exit overwritten');}}, {
  kind:'update',phase:'synthetic-replacement',error:'original failure',gateway:'preserve',installationRoot:${JSON.stringify(installed)}
});
if(process.env.OPENCLAW_UPDATE_IN_PROGRESS!=='1') throw new Error('updater role was changed');
process.exitCode=7;
`,
  );
  const result = await promisify(execFile)(
    process.execPath,
    ["--import", path.resolve("scripts/tsx.mjs"), runner],
    {
      cwd: root,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
        OPENCLAW_WORKSPACE_DIR: path.join(root, "workspace"),
        OPENCLAW_SHELL: "",
        CODEX_THREAD_ID: "",
        OPENCLAW_SUPERVISOR_MODE: "",
        OPENCLAW_UPDATE_RUN_HANDOFF: "",
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        [UPDATE_RUN_ID_ENV]: "completed-update-run",
        TSX_TSCONFIG_PATH: path.resolve("tsconfig.json"),
        NODE_OPTIONS: `--import ${path.resolve("scripts/tsx.mjs")}`,
      },
    },
  ).then(
    (completed) => ({ ...completed, code: 0 }),
    (error: unknown) => {
      if (
        !(error instanceof Error) ||
        !("stdout" in error) ||
        !("stderr" in error) ||
        !("code" in error)
      ) {
        throw error;
      }
      return { stdout: error.stdout, stderr: String(error.stderr), code: error.code };
    },
  );
  expect(result.code, result.stderr).toBe(7);
  expect(result.stdout).toBe('{"status":"error","reason":"original failure"}\n');
  expect(JSON.parse(await fs.readFile(receipt, "utf8"))).toMatchObject({
    args: ["triage"],
    message: { failure: { error: "original failure", gateway: "preserve" } },
    descendant: {
      updateRunId: null,
      handoff: null,
      sentinel: null,
      inProgress: null,
      shell: "exec",
      compileCache: "1",
    },
  });
  expect(result.stderr).toContain("Original failure retained");
  expect(result.stderr).not.toContain("could not complete");
});
