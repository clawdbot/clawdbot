import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const harness = process.cwd();
const posixIt = process.platform === "win32" ? it.skip : it;

describe("Docker E2E source and harness inputs", () => {
  posixIt.each<{
    script: string;
    dockerfiles?: string[];
    harnessDockerfile?: boolean;
    reuse?: boolean;
  }>([
    {
      script: "docker-selected-plugins.sh",
      dockerfiles: ["Dockerfile", "Dockerfile", "Dockerfile"],
    },
    {
      script: "plugin-binding-command-escape-docker.sh",
      dockerfiles: ["scripts/e2e/plugin-binding-command-escape.Dockerfile"],
      harnessDockerfile: true,
    },
    {
      script: "qr-import-docker.sh",
      dockerfiles: ["scripts/e2e/Dockerfile.qr-import"],
      harnessDockerfile: true,
    },
    { script: "agents-delete-shared-workspace-docker.sh", dockerfiles: ["Dockerfile"] },
    {
      script: "sandbox-browser-sidecar-docker.sh",
      dockerfiles: [
        "scripts/docker/sandbox/Dockerfile",
        "scripts/docker/sandbox/Dockerfile.browser",
      ],
      reuse: true,
    },
    { script: "compose-setup.sh", reuse: true },
    { script: "cli-installer-distribution-docker.sh", reuse: true },
  ])(
    "keeps candidate product inputs for $script",
    async ({ script, dockerfiles, harnessDockerfile, reuse }) => {
      const root = tempDirs.make("e2e-src-");
      const target = path.join(root, "candidate source");
      const bin = path.join(root, "bin");
      const log = path.join(root, "commands.jsonl");
      mkdirSync(target);
      mkdirSync(bin);
      writeFileSync(
        path.join(target, "Dockerfile"),
        'HEALTHCHECK CMD ["node", "dist/docker-healthcheck.js"]\n',
      );
      const packageTgz = path.join(root, "candidate.tgz");
      writeFileSync(packageTgz, "fixture package bytes");
      for (const command of ["docker", "git"]) {
        const file = path.join(bin, command);
        writeFileSync(
          file,
          `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ command: ${JSON.stringify(command)}, args }) + '\\n');
if (${JSON.stringify(command)} === 'git') {
  if (args.includes('rev-parse')) console.log('a'.repeat(40));
} else if (args[0] === 'build' || args[0] === 'buildx') {
  if (args.some((arg) => arg.includes('OPENCLAW_EXTENSIONS=missing-plugin'))) {
    console.error('unknown OPENCLAW_EXTENSIONS plugin id: missing-plugin');
    process.exit(49);
  }
} else if (
  args[0] === 'compose' ||
  (args[0] === 'run' && !args.some((arg) => arg.endsWith('-dependency-only')))
) {
  console.error('fixture-stop at product input boundary');
  process.exit(49);
}
`,
        );
        chmodSync(file, 0o755);
      }
      const socketPath = path.join(root, "docker.sock");
      const socket = createServer();
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.listen(socketPath, resolve);
      });
      try {
        const result = spawnSync("bash", [path.join(harness, "scripts/e2e", script)], {
          cwd: target,
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...process.env,
            PATH: `${bin}${path.delimiter}${process.env.PATH}`,
            TMPDIR: root,
            OPENCLAW_DOCKER_E2E_REPO_ROOT: target,
            OPENCLAW_CURRENT_PACKAGE_TGZ: packageTgz,
            OPENCLAW_SKIP_DOCKER_BUILD: reuse ? "1" : "0",
            OPENCLAW_DOCKER_SOCKET: socketPath,
          },
        });
        expect(result.status).not.toBe(0);
        expect(result.stdout + result.stderr).toContain("fixture-stop at product input boundary");
        const calls = readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { command: string; args: string[] });
        if (dockerfiles) {
          const builds = calls.filter(
            (call) =>
              call.command === "docker" &&
              (call.args[0] === "build" || call.args[0] === "buildx") &&
              call.args.at(-1) === target,
          );
          expect(builds.map((build) => build.args[build.args.indexOf("-f") + 1])).toEqual(
            dockerfiles.map((dockerfile) =>
              path.join(harnessDockerfile ? harness : target, dockerfile),
            ),
          );
        } else if (script === "compose-setup.sh") {
          expect(calls.find((call) => call.args[0] === "compose")?.args).toContain(
            path.join(target, "docker-compose.yml"),
          );
        } else {
          const gitCalls = calls.filter((call) => call.command === "git");
          expect(gitCalls.map((call) => call.args.slice(0, 2))).toEqual([
            ["-C", target],
            ["-C", target],
          ]);
          expect(
            calls.find((call) => call.args[0] === "run" && call.args.includes("-d"))?.args,
          ).toContain(`${target}/scripts/install.sh:/tmp/install.sh:ro`);
        }
      } finally {
        await new Promise<void>((resolve, reject) =>
          socket.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
  posixIt("packs candidate source through the sourced trusted package helper", () => {
    const root = tempDirs.make("e2e-pack-");
    const trusted = path.join(root, "trusted harness");
    const target = path.join(root, "candidate source");
    const lib = path.join(trusted, "scripts/lib");
    mkdirSync(lib, { recursive: true });
    mkdirSync(path.join(target, "scripts"), { recursive: true });
    copyFileSync("scripts/lib/docker-e2e-package.sh", path.join(lib, "docker-e2e-package.sh"));
    writeFileSync(
      path.join(target, "scripts/package-openclaw-for-docker.mjs"),
      "process.exit(47);\n",
    );
    const marker = path.join(root, "packer-source");
    writeFileSync(
      path.join(trusted, "scripts/package-openclaw-for-docker.mjs"),
      `
import fs from 'node:fs'; import path from 'node:path';
const value = (name) => process.argv[process.argv.indexOf(name) + 1];
fs.writeFileSync(${JSON.stringify(marker)}, value('--source-dir'));
const output = path.join(value('--output-dir'), value('--output-name'));
fs.writeFileSync(output, 'candidate bytes');
console.log(output);
`,
    );
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
set -euo pipefail
run_logged() { :; }
docker_e2e_docker_cmd() { :; }
docker_e2e_docker_run_cmd() { :; }
source "$TRUSTED/scripts/lib/docker-e2e-package.sh"
package="$(docker_e2e_prepare_package_tgz fixture)"
[[ "$(cat "$package")" == 'candidate bytes' ]]
docker_e2e_cleanup_package_tgz "$package"
`,
      ],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          ROOT_DIR: target,
          TRUSTED: trusted,
          TMPDIR: root,
          OPENCLAW_DOCKER_E2E_REPO_ROOT: target,
          OPENCLAW_CURRENT_PACKAGE_TGZ: "",
        },
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe(target);
  });
});
