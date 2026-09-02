import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";
const SCRIPT_PATH = path.resolve("scripts/test-live-cli-backend-docker.sh");
const { createTempDir } = createScriptTestHarness();
it("validates setup early and forwards argument overrides into Docker", () => {
  const invalid = spawnSync("bash", [SCRIPT_PATH], {
    encoding: "utf8",
    env: { ...process.env, OPENCLAW_LIVE_CLI_BACKEND_SETUP_TIMEOUT_SECONDS: "180s" },
  });
  expect(invalid.status).toBe(2);
  expect(invalid.stderr).toContain("invalid OPENCLAW_LIVE_CLI_BACKEND_SETUP_TIMEOUT_SECONDS: 180s");
  expect(invalid.stderr).not.toMatch(/Cannot find package 'tsx'|docker/);
  const root = createTempDir("openclaw-live-cli-capture-");
  const controls = [
    "OPENCLAW_LIVE_CLI_BACKEND_ARGS",
    "OPENCLAW_LIVE_CLI_BACKEND_RESUME_ARGS",
    "OPENCLAW_TEST_CONSOLE",
    "OPENCLAW_LIVE_CLI_BACKEND_CACHE_PROBE",
    "OPENCLAW_LIVE_CLI_BACKEND_ADVISORY",
    "OPENCLAW_LIVE_CLI_BACKEND_ALLOW_PROVIDER_SKIP",
  ];
  for (const dir of ["scripts", "bin", "home"]) mkdirSync(path.join(root, dir));
  symlinkSync(path.resolve("scripts/lib"), path.join(root, "scripts/lib"));
  for (const target of "scripts/test-live-build-docker.sh bin/docker bin/node bin/timeout".split(
    " ",
  )) {
    symlinkSync("/usr/bin/true", path.join(root, target));
  }
  const result = spawnSync("bash", ["-x", SCRIPT_PATH], {
    encoding: "utf8",
    env: {
      HOME: path.join(root, "home"),
      PATH: `${path.join(root, "bin")}:${process.env.PATH}`,
      OPENCLAW_LIVE_DOCKER_TRUSTED_HARNESS_DIR: root,
      ...Object.fromEntries(controls.map((key) => [key, "forwarded"])),
    },
  });
  expect(result.status).toBe(0);
  for (const key of controls) expect(result.stderr).toContain(`${key}=forwarded`);
});
