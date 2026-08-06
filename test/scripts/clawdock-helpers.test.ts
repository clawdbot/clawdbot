// Clawdock Helpers tests cover clawdock helpers script behavior.
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const shellCases = [
  { available: true, shell: "bash" },
  {
    available: spawnSync("zsh", ["--version"], { stdio: "ignore" }).status === 0,
    shell: "zsh",
  },
];

async function writeExecutable(file: string, content: string) {
  await writeFile(file, content, { mode: 0o755 });
}

describe("scripts/clawdock/clawdock-helpers.sh", () => {
  for (const { available, shell } of shellCases) {
    it.runIf(available)(
      `preserves caller state while auto-detecting the checkout in ${shell}`,
      async () => {
        const tempDir = await mkdtemp(path.join(tmpdir(), "openclaw-clawdock-"));
        try {
          const homeDir = path.join(tempDir, "home");
          const projectDir = path.join(homeDir, "openclaw");
          const confirmFile = path.join(tempDir, "confirm.txt");
          await mkdir(projectDir, { recursive: true });
          await writeFile(path.join(projectDir, "docker-compose.yml"), "services: {}\n");
          await writeFile(confirmFile, "\n");

          await execFileAsync(
            shell,
            [
              "-c",
              [
                'path_before="$PATH"',
                'candidate="caller-value"',
                'response="caller-response"',
                "source scripts/clawdock/clawdock-helpers.sh || exit 1",
                '_clawdock_ensure_dir < "$CLAWDOCK_CONFIRM_FILE" || exit 1',
                '[[ "$PATH" == "$path_before" ]] || exit 1',
                '[[ "$candidate" == "caller-value" ]] || exit 1',
                '[[ "$response" == "caller-response" ]] || exit 1',
                '[[ "$CLAWDOCK_DIR" == "$HOME/openclaw" ]] || exit 1',
              ].join("\n"),
            ],
            {
              cwd: repoRoot,
              env: {
                ...process.env,
                CLAWDOCK_CONFIRM_FILE: confirmFile,
                CLAWDOCK_DIR: "",
                HOME: homeDir,
              },
            },
          );

          await expect(readFile(path.join(homeDir, ".clawdock", "config"), "utf8")).resolves.toBe(
            `CLAWDOCK_DIR="${projectDir}"\n`,
          );
        } finally {
          await rm(tempDir, { force: true, recursive: true });
        }
      },
    );
  }

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
      await writeExecutable(
        path.join(binDir, "docker"),
        `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$CLAWDOCK_DOCKER_ARGS_FILE"
`,
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

  it("opens dashboard URLs through the published gateway port without starting dependencies", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "openclaw-clawdock-"));
    try {
      const projectDir = path.join(tempDir, "project");
      const binDir = path.join(tempDir, "bin");
      const argsFile = path.join(tempDir, "docker-args.txt");
      const openedUrlFile = path.join(tempDir, "opened-url.txt");
      await mkdir(projectDir);
      await mkdir(binDir);
      await writeFile(path.join(projectDir, "docker-compose.yml"), "services: {}\n");
      await writeExecutable(
        path.join(binDir, "docker"),
        `#!/usr/bin/env bash
printf '%s\\n' "$@" >> "$CLAWDOCK_DOCKER_ARGS_FILE"
printf '%s\\n' '---' >> "$CLAWDOCK_DOCKER_ARGS_FILE"
if [[ "$*" == *" port openclaw-gateway 18789" ]]; then
  printf '%s\\n' '0.0.0.0:19001'
else
  printf '%s\\n' 'Dashboard: http://127.0.0.1:18789/?token=test-token'
fi
`,
      );
      await writeExecutable(
        path.join(binDir, "open"),
        `#!/usr/bin/env bash
printf '%s\\n' "$1" > "$CLAWDOCK_OPENED_URL_FILE"
`,
      );

      await execFileAsync(
        "bash",
        ["-c", "source scripts/clawdock/clawdock-helpers.sh; clawdock-dashboard"],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            CLAWDOCK_DIR: projectDir,
            CLAWDOCK_DOCKER_ARGS_FILE: argsFile,
            CLAWDOCK_OPENED_URL_FILE: openedUrlFile,
            HOME: path.join(tempDir, "home"),
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );

      await expect(readFile(openedUrlFile, "utf8")).resolves.toBe(
        "http://127.0.0.1:19001/?token=test-token\n",
      );
      await expect(readFile(argsFile, "utf8")).resolves.toBe(
        [
          "compose",
          "-f",
          path.join(projectDir, "docker-compose.yml"),
          "run",
          "--rm",
          "--no-deps",
          "openclaw-cli",
          "dashboard",
          "--no-open",
          "---",
          "compose",
          "-f",
          path.join(projectDir, "docker-compose.yml"),
          "port",
          "openclaw-gateway",
          "18789",
          "---",
          "",
        ].join("\n"),
      );
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});
