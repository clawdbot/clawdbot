import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

it("installs with the tooling cwd while retaining the release source root", () => {
  const workflow = parse(readFileSync(".github/workflows/openclaw-release-publish.yml", "utf8"));
  const install = workflow.jobs.publish.steps.find(
    (step: { name: string }) => step.name === "Install trusted release tooling dependencies",
  );
  const source = createTempDir("release-tooling-bootstrap-");
  const tooling = join(source, ".release-harness");
  const bin = join(source, "bin");
  const receipt = join(source, "install-cwd");
  mkdirSync(tooling);
  mkdirSync(bin);
  writeFileSync(join(bin, "pnpm"), '#!/bin/sh\npwd > "$INSTALL_CWD"\nmkdir -p node_modules\n', {
    mode: 0o755,
  });
  const result = spawnSync("bash", ["-c", `${install.run}\npwd`], {
    cwd: source,
    encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, INSTALL_CWD: receipt },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(realpathSync(readFileSync(receipt, "utf8").trim())).toBe(realpathSync(tooling));
  expect(realpathSync(result.stdout.trim())).toBe(realpathSync(source));
  expect(realpathSync(join(source, "node_modules"))).toBe(
    realpathSync(join(tooling, "node_modules")),
  );
});
