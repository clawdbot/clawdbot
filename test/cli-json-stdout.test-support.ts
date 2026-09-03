import { spawnSync } from "node:child_process";
import path from "node:path";
import { applyVitestResourceContextToChildEnv } from "../src/infra/vitest-resource-ownership.js";

export function runBuiltCli(
  tempHome: string,
  args: string[],
  envOverrides: NodeJS.ProcessEnv = {},
  options: { inheritEnvironment?: boolean } = {},
) {
  const env: NodeJS.ProcessEnv = {
    ...(options.inheritEnvironment === false ? { PATH: process.env.PATH } : process.env),
    HOME: tempHome,
    USERPROFILE: tempHome,
    OPENCLAW_TEST_FAST: "1",
  };
  delete env.OPENCLAW_HOME;
  delete env.OPENCLAW_STATE_DIR;
  delete env.OPENCLAW_CONFIG_PATH;
  delete env.VITEST;
  Object.assign(env, envOverrides);
  applyVitestResourceContextToChildEnv(env);

  const entry = path.resolve(process.cwd(), "openclaw.mjs");
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60_000,
  });
}
