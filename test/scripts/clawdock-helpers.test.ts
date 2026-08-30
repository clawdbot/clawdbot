// Clawdock Helpers tests cover clawdock helpers script behavior.
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
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

async function withDiagnosticFixture(
  shell: string,
  run: (fixture: {
    projectDir: string;
    configDir: string;
    binDir: string;
    containerDir: string;
    invoke: (command: string, mode?: string) => ReturnType<typeof spawnSync>;
  }) => Promise<void>,
) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "openclaw-clawdock-diagnostics-"));
  try {
    const homeDir = path.join(tempDir, "home");
    const projectDir = path.join(tempDir, "project");
    const configDir = path.join(homeDir, ".openclaw");
    const binDir = path.join(tempDir, "bin");
    const containerDir = path.join(tempDir, "container");
    for (const dir of [projectDir, configDir, binDir, containerDir]) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(path.join(projectDir, "docker-compose.yml"), "services: {}\n");
    await writeFile(
      path.join(containerDir, "config.json"),
      JSON.stringify({ gateway: { remote: { token: "synthetic-saved-mismatch" } } }),
    );
    await writeExecutable(path.join(binDir, "node"), "#!/bin/sh\nexit 127\n");
    await mkdir(path.join(containerDir, "node_modules"));
    for (const dependency of ["dotenv", "json5"]) {
      await symlink(
        path.dirname(createRequire(import.meta.url).resolve(`${dependency}/package.json`)),
        path.join(containerDir, "node_modules", dependency),
        "dir",
      );
    }
    await writeExecutable(path.join(binDir, "sleep"), "#!/bin/sh\nexit 0\n");
    await writeExecutable(
      path.join(binDir, "docker"),
      `#!/bin/bash
[[ "$1" == compose && "$2" == -f ]] || exit 90
shift 3
if [[ "$1" == run ]]; then
  [[ "$2" == --rm && "$3" == --no-deps && "$4" == -T && "$5" == --entrypoint && "$6" == node && "$7" == openclaw-gateway ]] || exit 95
  shift 7
  cd "$CLAWDOCK_TEST_CONTAINER" || exit 93
  if [[ "$CLAWDOCK_TEST_MODE" == failed-renderer ]]; then
    "${process.execPath}" "$@"
    printf '%s\\n' "$CLAWDOCK_TEST_NOISE"
    printf '%s\\n' "$CLAWDOCK_TEST_NOISE" >&2
    exit 1
  fi
  exec "${process.execPath}" "$@"
fi
if [[ "$1" == restart ]]; then
  printf '%s\\n' restart >> "$CLAWDOCK_TEST_CONTAINER/events"
  printf '%s\\n' "$CLAWDOCK_TEST_NOISE"
  printf '%s\\n' "$CLAWDOCK_TEST_NOISE" >&2
  [[ "$CLAWDOCK_TEST_MODE" != restart-failure ]]
  exit $?
fi
[[ "$1" == exec ]] || exit 91
shift
if [[ "$1" == -T ]]; then shift; fi
if [[ "$1" == -e ]]; then export "$2"; shift 2; fi
[[ "$1" == openclaw-gateway ]] || exit 92
shift
cd "$CLAWDOCK_TEST_CONTAINER" || exit 93
if [[ "$1" == node ]]; then shift; exec "${process.execPath}" "$@"; fi
exec "$@"
`,
    );
    await writeExecutable(
      path.join(containerDir, "openclaw.mjs"),
      `#!${process.execPath}
import fs from 'node:fs';
const [, action, key, value] = process.argv.slice(2);
const mode = process.env.CLAWDOCK_TEST_MODE;
const file = process.env.CLAWDOCK_TEST_CONTAINER + '/config.json';
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
fs.appendFileSync('events', JSON.stringify({ action, key, value }) + '\\n');
console.error(process.env.CLAWDOCK_TEST_NOISE);
if (action === 'set') {
  console.error(config.gateway?.remote?.token);
  console.log(value);
  if (mode === 'write-failure-' + key) process.exit(1);
  const owner = key.split('.')[1];
  config.gateway ??= {};
  config.gateway[owner] = { token: value };
  fs.writeFileSync(file, JSON.stringify(config));
} else if (action === 'get') {
  console.log('__OPENCLAW_REDACTED__');
} else process.exit(94);
`,
    );
    await run({
      projectDir,
      configDir,
      binDir,
      containerDir,
      invoke: (command, mode = "success") =>
        spawnSync(shell, ["-f", "-c", `source scripts/clawdock/clawdock-helpers.sh\n${command}`], {
          cwd: repoRoot,
          encoding: "utf8",
          env: {
            HOME: homeDir,
            PATH: `${binDir}:/usr/bin:/bin`,
            CLAWDOCK_DIR: projectDir,
            CLAWDOCK_TEST_CONTAINER: containerDir,
            CLAWDOCK_TEST_MODE: mode,
            CLAWDOCK_TEST_NOISE: "synthetic-backend-credential-do-not-display",
          },
        }),
    });
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

describe("scripts/clawdock/clawdock-helpers.sh", () => {
  for (const { available, shell } of shellCases) {
    describe.runIf(available)(`safe diagnostics in ${shell}`, () => {
      it.each([
        { token: "~!", mode: "success" },
        { token: "synthetic-token-".repeat(6), mode: "success" },
        { token: "synthetic-$literal-'token", mode: "success" },
        ...[
          "write-failure-gateway.remote.token",
          "write-failure-gateway.auth.token",
          "restart-failure",
        ].map((mode) => ({ token: "synthetic-provided-token-0123456789", mode })),
      ])("repairs without disclosure: $mode ($token)", async ({ token, mode }) => {
        await withDiagnosticFixture(shell, async ({ projectDir, containerDir, invoke }) => {
          const envFile = path.join(projectDir, ".env");
          const envContent = `OPENCLAW_GATEWAY_TOKEN="${token}"\n`;
          await writeFile(envFile, envContent);
          const result = invoke("clawdock-fix-token", mode);
          const output = `${result.stdout}${result.stderr}`;
          for (const secret of [
            token,
            token.slice(0, 20),
            "synthetic-saved-mis",
            "synthetic-backend",
          ]) {
            expect(output).not.toContain(secret);
          }
          expect(result.status).toBe(mode === "success" ? 0 : 1);
          const events = await readFile(path.join(containerDir, "events"), "utf8");
          expect(events).toContain(
            JSON.stringify({ action: "set", key: "gateway.remote.token", value: token }),
          );
          if (mode !== "write-failure-gateway.remote.token") {
            expect(events).toContain(
              JSON.stringify({ action: "set", key: "gateway.auth.token", value: token }),
            );
          }
          if (mode === "success") {
            expect(output).toContain("Token configured");
            expect(output).not.toContain("mismatch");
            expect(output).toContain("Configuration complete");
            expect(events).toContain("restart\n");
            expect(
              JSON.parse(await readFile(path.join(containerDir, "config.json"), "utf8")),
            ).toEqual({
              gateway: { remote: { token }, auth: { token } },
            });
          } else {
            expect(output).not.toContain("Configuration complete");
            expect(output).toMatch(/failed|mismatch/i);
            expect(output).toMatch(/check|try/i);
            if (mode !== "restart-failure") expect(events).not.toContain("restart\n");
          }
          const reveal = invoke("clawdock-token");
          expect(reveal.status).toBe(0);
          expect(reveal.stdout).toBe(token);
          expect(reveal.stderr).toBe("");
          await expect(readFile(envFile, "utf8")).resolves.toBe(envContent);
        });
      });

      it("keeps config structure and env keys without values, comments or multiline fragments", async () => {
        await withDiagnosticFixture(shell, async ({ configDir, projectDir, invoke }) => {
          const configContent = `{
  // synthetic-json-comment
  gateway: {auth: {token: 'synthetic-json-token'}, remote: {password: '~!'},},
  plugins: [{options: {arbitrary: 'synthetic-plugin-secret'},},],
  env: {OPAQUE: ['synthetic-array-secret', 782931, true, null,],},
  empty: {},
}`;
          const envContent = [
            "# synthetic-comment-secret",
            "API_KEY=synthetic-env-secret",
            "EMPTY=",
            'export EXPORTED = "synthetic-export-secret"',
            'MULTILINE="synthetic-first-line',
            "synthetic-second-line",
            "SYNTHETIC_CONTINUATION=synthetic-third-line",
            'synthetic-last-line"',
            "SINGLE='synthetic-single-first",
            "SYNTHETIC_SINGLE_CONTINUATION=synthetic-single-last'",
            "AFTER=synthetic-after-secret",
            "synthetic unknown content",
            "CUSTOM.KEY=synthetic-custom-value",
          ].join("\n");
          const files = new Map([
            [path.join(configDir, "openclaw.json"), configContent],
            [path.join(configDir, ".env"), envContent],
            [path.join(projectDir, ".env"), envContent],
          ]);
          for (const [file, content] of files) {
            await writeFile(file, content);
          }
          const result = invoke("clawdock-show-config");
          const output = `${result.stdout}${result.stderr}`;
          expect(result.status).toBe(0);
          expect(output).not.toMatch(/synthetic|SYNTHETIC|~!|782931/);
          expect(output).toContain('"gateway"');
          expect(output).toContain('"plugins": [');
          expect(output).toContain('"arbitrary"');
          for (const key of [
            "API_KEY",
            "EMPTY",
            "EXPORTED",
            "MULTILINE",
            "SINGLE",
            "AFTER",
            "CUSTOM.KEY",
          ]) {
            expect(
              output.match(new RegExp(`${key.replace(".", "\\.")}=<redacted>`, "g")),
            ).toHaveLength(2);
          }
          expect(output).toContain("redacted");
          expect(
            JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1)),
          ).toEqual({
            gateway: { auth: { token: "<redacted>" }, remote: { password: "<redacted>" } },
            plugins: [{ options: { arbitrary: "<redacted>" } }],
            env: { OPAQUE: ["<redacted>", "<redacted>", "<redacted>", "<redacted>"] },
            empty: {},
          });
          for (const [file, content] of files) {
            await expect(readFile(file, "utf8")).resolves.toBe(content);
          }
        });
      });

      it.each([
        "invalid-json",
        "missing-json5",
        "missing-dotenv",
        "missing-docker",
        "failed-renderer",
      ])("fails closed for %s", async (mode) => {
        await withDiagnosticFixture(shell, async ({ configDir, binDir, containerDir, invoke }) => {
          const file = path.join(configDir, "openclaw.json");
          const content =
            mode === "invalid-json"
              ? '{"token":"synthetic-parse-secret",'
              : '{"token":"synthetic-parse-secret"}';
          await writeFile(file, content);
          await writeFile(path.join(configDir, ".env"), "API_KEY=synthetic-env-secret\n");
          if (mode === "missing-json5" || mode === "missing-dotenv") {
            await rm(path.join(containerDir, "node_modules", mode.slice("missing-".length)));
          } else if (mode === "missing-docker") {
            await writeExecutable(path.join(binDir, "docker"), "#!/bin/sh\nexit 127\n");
          }
          const result = invoke("clawdock-show-config", mode);
          expect(result.status).toBe(1);
          expect(`${result.stdout}${result.stderr}`).not.toContain("synthetic");
          expect(result.stdout).toMatch(/unable|failed|unavailable/i);
          expect(result.stdout).toMatch(/check|install/i);
          await expect(readFile(file, "utf8")).resolves.toBe(content);
        });
      });

      it.each(['"', "'", "`"])(
        "withholds ambiguous unterminated env quoting: %s",
        async (quote) => {
          await withDiagnosticFixture(shell, async ({ configDir, invoke }) => {
            const file = path.join(configDir, ".env");
            const content = `TOKEN=${quote}synthetic-first-line\nSYNTHETIC_CONTINUATION=synthetic-tail\n`;
            await writeFile(file, content);
            const result = invoke("clawdock-show-config");
            expect(result.status).toBe(1);
            expect(`${result.stdout}${result.stderr}`).not.toMatch(/synthetic|SYNTHETIC/);
            expect(result.stdout).toContain("Unable to safely display");
            await expect(readFile(file, "utf8")).resolves.toBe(content);
          });
        },
      );
    });

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
