import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveCurrentOpenClawCliInvocation } from "./openclaw-cli-invocation.js";

const requireFromHere = createRequire(import.meta.url);
const checkoutTsconfig = fileURLToPath(new URL("../../tsconfig.json", import.meta.url));

export async function createSourceCliFixture(root: string) {
  const realRoot = await fs.realpath(root);
  const checkout = path.join(realRoot, "OpenClaw source & ^ %USERPROFILE%!");
  const callerCwd = path.join(realRoot, "agent-workspace");
  const entryPath = path.join(checkout, "src", "entry.ts");
  const execArgv = ["--import", pathToFileURL(requireFromHere.resolve("tsx")).href];
  await fs.mkdir(path.dirname(entryPath), { recursive: true });
  await fs.mkdir(callerCwd);
  await fs.writeFile(
    path.join(checkout, "package.json"),
    JSON.stringify({ name: "openclaw", type: "module" }),
  );
  await fs.writeFile(
    path.join(checkout, "tsconfig.json"),
    JSON.stringify({ extends: checkoutTsconfig }),
  );
  // A caller's own project must not choose the CLI's workspace package mapping.
  await fs.writeFile(path.join(callerCwd, "tsconfig.json"), "{}");
  await fs.writeFile(
    entryPath,
    [
      'import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";',
      'const source: string = normalizeUniqueStringEntries(["gateway", "gateway"]).join("");',
      'console.log(JSON.stringify({ source, args: process.argv.slice(2), cwd: process.cwd(), tsconfigPath: process.env.TSX_TSCONFIG_PATH, pathHead: process.env.PATH?.split(process.platform === "win32" ? ";" : ":")[0] }));',
    ].join("\n"),
  );
  const invocation = resolveCurrentOpenClawCliInvocation([], {
    argv1: entryPath,
    cwd: callerCwd,
    execArgv,
    execPath: process.execPath,
  });
  return { checkout, callerCwd, entryPath, execArgv, invocation };
}

export function runSourceCliProbe(
  command: string,
  args: string[],
  cwd: string,
  options: { env?: Record<string, string>; windowsVerbatimArguments?: boolean } = {},
) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
    windowsVerbatimArguments: options.windowsVerbatimArguments,
    env: {
      ...process.env,
      TSX_TSCONFIG_PATH: undefined,
      TSX_DISABLE_CACHE: "1",
      ...options.env,
    },
  });
}

/** Reconstruct commands from a real source-mode parent without leaving global argv changed. */
export function withSourceCliParent<T>(
  fixture: Awaited<ReturnType<typeof createSourceCliFixture>>,
  run: () => T,
): T {
  const argv = process.argv;
  const execArgv = process.execArgv;
  try {
    process.argv = [process.execPath, fixture.entryPath];
    process.execArgv = fixture.execArgv;
    return run();
  } finally {
    process.argv = argv;
    process.execArgv = execArgv;
  }
}
