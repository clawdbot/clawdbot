import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runQaCli } from "./suite-runtime-agent-process.js";

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
          primaryModel: "openai/gpt-5.5",
          alternateModel: "openai/gpt-5.5",
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
});
