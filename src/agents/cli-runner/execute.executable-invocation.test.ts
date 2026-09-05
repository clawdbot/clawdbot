import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { text } from "node:stream/consumers";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { CliBackendExecute } from "../../plugins/cli-backend.types.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { executePreparedCliRun as executePreparedCliRunImpl } from "./execute.js";
import { wrapPreparedCliRunWithTestAdmission } from "./execute.test-support.js";

const executePreparedCliRun = wrapPreparedCliRunWithTestAdmission(executePreparedCliRunImpl);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runVerifiedFixture(command: string, args: string[]) {
  const execute: CliBackendExecute = async function* (context) {
    const child = spawn(context.command, context.args, {
      argv0: context.argv0,
      cwd: context.cwd,
      env: context.env,
      signal: context.abortSignal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const [[code], stdout, stderr] = await Promise.all([
      once(child, "close"),
      text(child.stdout),
      text(child.stderr),
    ]);
    if (code !== 0) {
      throw new Error(stderr || `Fixture CLI exited with code ${code}`);
    }
    yield { type: "result", subtype: "success", result: stdout };
  };
  const context = buildPreparedCliRunContext({
    backend: {
      command,
      args,
      modelArg: undefined,
      sessionArgs: undefined,
      systemPromptFileArg: undefined,
      input: "stdin",
      output: "jsonl",
      jsonlDialect: "claude-stream-json",
    },
    onSuccessfulAuthBinding: () => {},
    runtimeArtifact: {
      kind: "bundled-package-tree",
      packageName: "@fixture/cli-invocation",
      entrypoint: "command",
      nativeExecutableNames: ["cli-fixture"],
    },
  });
  context.authBindingFingerprint = "fixture-owner";
  context.executionTarget = { kind: "plugin", execute };
  return executePreparedCliRun(context);
}

it("runs a verified plugin CLI script through its resolved interpreter", async () => {
  const root = tempDirs.make("openclaw-plugin-cli-invocation-");
  const entrypoint = path.join(root, "cli.js");
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "@fixture/cli-invocation", version: "1.0.0" }),
  );
  await fs.writeFile(
    entrypoint,
    `#!${process.execPath}\nprocess.stdout.write("fixture-script:" + process.argv.slice(2).join("|"));\n`,
    { mode: 0o755 },
  );
  let command = entrypoint;
  if (process.platform === "win32") {
    command = path.join(root, "cli.cmd");
    await fs.writeFile(command, '@echo off\r\n"%~dp0\\cli.js" %*\r\n');
  }

  await expect(runVerifiedFixture(command, ["--fixture-option", "kept"])).resolves.toMatchObject({
    text: "fixture-script:--fixture-option|kept",
  });
});

it.skipIf(process.platform === "win32")(
  "preserves a verified native CLI's symlink invocation name in a plugin process",
  async () => {
    const root = tempDirs.make("openclaw-plugin-cli-alias-");
    const command = path.join(root, "cli-fixture");
    await fs.symlink(process.execPath, command);

    await expect(
      runVerifiedFixture(command, ["-e", "process.stdout.write(process.argv0)"]),
    ).resolves.toMatchObject({ text: command });
  },
);
