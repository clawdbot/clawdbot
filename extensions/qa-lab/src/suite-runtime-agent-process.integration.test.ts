// Qa Lab tests cover suite runtime agent process.integration plugin behavior.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runQaCli } from "./qa-cli-process.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe("qa suite runtime CLI integration", () => {
  it("runs the plugin-owned memory status command with staged CLI metadata", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-cli-memory-repo-"));
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "qa-cli-memory-runtime-"));
    cleanups.push(async () => {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(tempRoot, { recursive: true, force: true });
    });
    const distDir = path.join(repoRoot, "dist");
    const bundledPluginsDir = path.join(tempRoot, "dist", "extensions");
    await mkdir(path.join(distDir), { recursive: true });
    await mkdir(path.join(bundledPluginsDir, "memory-core"), { recursive: true });
    await writeFile(
      path.join(bundledPluginsDir, "memory-core", "cli-metadata.js"),
      "export default { id: 'memory-core' };\n",
      "utf8",
    );
    await writeFile(
      path.join(distDir, "index.js"),
      [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "const [command, subcommand] = process.argv.slice(2);",
        "const metadataPath = path.join(process.env.OPENCLAW_BUNDLED_PLUGINS_DIR ?? '', 'memory-core', 'cli-metadata.js');",
        "if (command === 'memory' && subcommand === 'status' && fs.existsSync(metadataPath)) {",
        "  console.log(JSON.stringify({ command, subcommand, status: 'ok' }));",
        "  process.exit(0);",
        "}",
        "console.error(\"error: unknown command 'memory'\");",
        "process.exit(1);",
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(
      runQaCli(
        {
          repoRoot,
          gateway: {
            tempRoot,
            runtimeEnv: {
              ...process.env,
              OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
            },
          },
          primaryModel: "openai/gpt-5.6-luna",
          alternateModel: "openai/gpt-5.6-luna",
          providerMode: "mock-openai",
        } as never,
        ["memory", "status", "--json"],
        { json: true },
      ),
    ).resolves.toEqual({
      command: "memory",
      subcommand: "status",
      status: "ok",
    });
  });

  it("retains real child output when the qa cli times out", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-cli-timeout-repo-"));
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "qa-cli-timeout-runtime-"));
    cleanups.push(async () => {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(tempRoot, { recursive: true, force: true });
    });
    const distDir = path.join(repoRoot, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(
      path.join(distDir, "index.js"),
      [
        'process.stdout.write("timeout stdout marker\\n");',
        'process.stderr.write("timeout stderr marker\\n");',
        "setInterval(() => {}, 60_000);",
        "",
      ].join("\n"),
      "utf8",
    );

    const error = await runQaCli(
      {
        repoRoot,
        gateway: {
          tempRoot,
          runtimeEnv: process.env,
        },
        primaryModel: "openai/gpt-5.6-luna",
        alternateModel: "openai/gpt-5.6-luna",
        providerMode: "mock-openai",
      } as never,
      ["qa", "suite"],
      { timeoutMs: 1_000 },
    ).catch((value: unknown) => value);

    expect(error).toMatchObject({ code: "qa_cli_timeout" });
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain("qa cli timed out: openclaw qa suite");
    expect(message).toContain("stdout:\ntimeout stdout marker");
    expect(message).toContain("stderr:\ntimeout stderr marker");
  });
});
