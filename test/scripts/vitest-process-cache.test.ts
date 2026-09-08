import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { spawnOwnedVitestProcess } from "../../scripts/lib/vitest-process.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { resolveNativeFixtureShortPath } from "./native-boundary-fixture.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const tsxPreload = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;

it.each(["hermetic", "live-aware", "tooling"] as const)(
  "keeps source compiler caching inside the owned namespace (%s)",
  async (homeMode) => {
    const root = fs.realpathSync(tempDirs.make("oc-vt-source-cache-"));
    const sourcePath = path.join(root, "source.mts");
    fs.writeFileSync(sourcePath, "enum Value { Answer = 42 }\nconsole.log(Value.Answer);\n");
    const script = `
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const result = spawnSync(process.execPath, ["--import", ${JSON.stringify(tsxPreload)}, ${JSON.stringify(sourcePath)}], { encoding: "utf8" });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(result.stderr);
const namespace = os.tmpdir();
const cache = path.join(namespace, "tsx-" + (process.geteuid?.() ?? os.userInfo().username));
console.log(JSON.stringify({ namespace, output: result.stdout, cached: fs.existsSync(cache) && fs.readdirSync(cache).length > 0 }));
`;
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      USERPROFILE: root,
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      TSX_DISABLE_CACHE: "1",
      NODE_DISABLE_COMPILE_CACHE: "1",
      ESBUILD_WORKER_THREADS: "0",
    };
    const { child, completion } = spawnOwnedVitestProcess({
      command: process.execPath,
      args: ["--input-type=module", "-e", script],
      homeMode,
      options: { env, stdio: ["ignore", "pipe", "pipe"] },
    });
    let output = "";
    let errorOutput = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      errorOutput += chunk.toString();
    });
    expect(await completion, errorOutput).toMatchObject({
      code: 0,
      groupJoined: process.platform !== "win32",
    });
    const observed = JSON.parse(output);
    expect(observed.output).toBe("42\n");
    expect(observed.cached).toBe(homeMode !== "tooling");
    expect(path.dirname(observed.namespace)).toBe(root);
    expect(env.TSX_DISABLE_CACHE).toBe("1");
    expect(fs.existsSync(observed.namespace)).toBe(process.platform === "win32");
  },
);

it.skipIf(process.platform !== "win32")(
  "publishes long temp paths to owned Windows children",
  async ({ skip }) => {
    const root = tempDirs.make("oc-vt-short-name-");
    const shortRoot = resolveNativeFixtureShortPath(root);
    if (!shortRoot) {
      skip();
      return;
    }
    const { child, completion } = spawnOwnedVitestProcess({
      command: process.execPath,
      args: [
        "-e",
        "console.log(JSON.stringify([process.env.TMPDIR, process.env.TMP, process.env.TEMP]))",
      ],
      homeMode: "tooling",
      options: {
        env: { ...process.env, TMPDIR: shortRoot, TMP: shortRoot, TEMP: shortRoot },
        stdio: ["ignore", "pipe", "pipe"],
      },
    });
    let output = "";
    let errorOutput = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      errorOutput += chunk.toString();
    });
    expect((await completion).code, errorOutput).toBe(0);
    const [tmpdir, tmp, temp] = JSON.parse(output);
    expect(tmpdir).toBe(fs.realpathSync.native(tmpdir));
    expect(path.dirname(tmpdir)).toBe(fs.realpathSync.native(root));
    expect([tmp, temp]).toEqual([tmpdir, tmpdir]);
  },
);
