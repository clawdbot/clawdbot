import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("scripts/clawdock/clawdock-helpers.sh", () => {
  it("loads the standard docker-compose.override.yml before ClawDock extra overrides", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "openclaw-clawdock-"));
    try {
      const projectDir = path.join(tempDir, "project");
      const binDir = path.join(tempDir, "bin");
      const argsFile = path.join(tempDir, "docker-args.txt");
      await mkdir(projectDir);
      await mkdir(binDir);
      await writeFile(path.join(projectDir, "docker-compose.yml"), "services: {}\n");
      await writeFile(path.join(projectDir, "docker-compose.override.yml"), "services: {}\n");
      await writeFile(path.join(projectDir, "docker-compose.extra.yml"), "services: {}\n");
      await writeFile(
        path.join(binDir, "docker"),
        `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$CLAWDOCK_DOCKER_ARGS_FILE"
`,
        { mode: 0o755 },
      );

      await execFileAsync(
        "bash",
        ["-c", "source scripts/clawdock/clawdock-helpers.sh; _clawdock_compose config"],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            CLAWDOCK_DIR: projectDir,
            CLAWDOCK_DOCKER_ARGS_FILE: argsFile,
            HOME: path.join(tempDir, "home"),
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );

      await expect(readFile(argsFile, "utf8")).resolves.toBe(
        [
          "compose",
          "-f",
          path.join(projectDir, "docker-compose.yml"),
          "-f",
          path.join(projectDir, "docker-compose.override.yml"),
          "-f",
          path.join(projectDir, "docker-compose.extra.yml"),
          "config",
          "",
        ].join("\n"),
      );
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});
