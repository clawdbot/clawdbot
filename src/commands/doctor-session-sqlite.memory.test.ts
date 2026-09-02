import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build as esbuild } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import { runtimeProcessCoreBuildEntries } from "../../scripts/lib/runtime-process-core-build-entries.mts";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { sqliteImportMemorySupportUrl } from "./doctor-session-sqlite.memory.test-support.js";

const execFileAsync = promisify(execFile);
let bundleDir: string;
let childPath: string;

beforeAll(async () => {
  fs.mkdirSync(path.join(process.cwd(), ".artifacts"), { recursive: true });
  bundleDir = fs.mkdtempSync(path.join(process.cwd(), ".artifacts/import-memory-"));
  // Runtime workers resolve stable packaged paths beneath dist, even from a bundled caller.
  const outDir = path.join(bundleDir, "dist");
  fs.mkdirSync(outDir);
  childPath = path.join(outDir, "child.js");
  for (const schema of ["openclaw-agent-schema.sql", "openclaw-state-schema.sql"]) {
    fs.copyFileSync(path.join(process.cwd(), "src/state", schema), path.join(outDir, schema));
  }
  await esbuild({
    bundle: true,
    entryPoints: {
      child: fileURLToPath(sqliteImportMemorySupportUrl),
      ...runtimeProcessCoreBuildEntries,
    },
    format: "esm",
    // Keep generated source overhead out of the transcript-data heap budget;
    // preserve function/class names used by runtime dispatch and diagnostics.
    minify: true,
    keepNames: true,
    outdir: outDir,
    external: Object.entries(packageJson.dependencies)
      .filter(([, version]) => !version.startsWith("workspace:"))
      .map(([name]) => name),
    platform: "node",
    target: "node22",
  });
});
afterAll(() => {
  if (bundleDir) {
    fs.rmSync(bundleDir, { force: true, recursive: true });
  }
});

it.each(["batch", "deep", "public"])(
  "imports %s transcripts and completes branch projections under a 256 MiB heap",
  async (scenario) => {
    await withOpenClawTestState({ applyEnv: false, label: "import-memory" }, async (state) => {
      const { stdout } = await execFileAsync(
        process.execPath,
        ["--max-old-space-size=256", childPath, state.stateDir, scenario],
        {
          cwd: process.cwd(),
          env: state.env,
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
          timeout: 240_000,
        },
      );
      expect(JSON.parse(stdout)).toMatchObject({ scenario });
      console.info(stdout.trim());
    });
  },
  240_000,
);
