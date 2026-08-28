import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { copyDockerSchedulerHarness } from "./docker-all-harness.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const posixIt = process.platform === "win32" ? it.skip : it;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const laneNames = ["gateway-network", "gateway-concurrency", "live-models"];

function writeJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

function setupFixture(
  mode: "split" | "override" | "local",
  missingTargetScript = false,
  corepack = false,
) {
  const artifactRoot = path.resolve(".artifacts");
  mkdirSync(artifactRoot, { recursive: true });
  const root = realpathSync(tempDirs.make("docker-harness-", artifactRoot));
  const target = path.join(root, "frozen pnpm target");
  mkdirSync(target);
  const harness = mode === "local" ? target : path.join(target, ".release-harness");
  const selectedHarness =
    mode === "override" ? path.join(root, "operator's $& pnpm harness") : harness;
  copyDockerSchedulerHarness(harness);
  if (selectedHarness !== harness) mkdirSync(selectedHarness, { recursive: true });
  const marker = path.join(root, "calls.jsonl");
  const poison = path.join(root, "target-ran");
  const toolchainMarker = path.join(root, "toolchains.jsonl");
  const version = "2026.8.1";
  const packageDir = path.join(root, "packed", "package");
  writeJson(path.join(packageDir, "package.json"), { name: "openclaw", version });
  const tarball = path.join(root, "frozen candidate.tgz");
  execFileSync("tar", ["-czf", tarball, "-C", path.dirname(packageDir), "package"]);
  const sha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  const trustedScript = `
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
  lane: process.env.OPENCLAW_DOCKER_ALL_LANE_NAME,
  cwd: process.cwd(),
  phase: process.argv[2],
  registry: process.env.OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR,
  registryVersion: process.env.OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION,
  registrySha256: process.env.OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256,
  target: process.env.OPENCLAW_DOCKER_E2E_REPO_ROOT,
  harness: process.env.OPENCLAW_DOCKER_E2E_TRUSTED_HARNESS_DIR,
  liveTarget: process.env.OPENCLAW_LIVE_DOCKER_REPO_ROOT,
  package: process.env.OPENCLAW_CURRENT_PACKAGE_TGZ,
  sha256: process.env.OPENCLAW_CURRENT_PACKAGE_SHA256,
  selectedSha: process.env.OPENCLAW_DOCKER_E2E_SELECTED_SHA,
  cache: process.env.OPENCLAW_DOCKER_CACHE_HOME_DIR,
  tools: process.env.OPENCLAW_DOCKER_CLI_TOOLS_DIR,
}) + '\\n');
`;
  const poisonedScript = `require('node:fs').writeFileSync(${JSON.stringify(poison)}, 'old harness'); process.exit(47);`;
  for (const [dir, script] of [
    [target, poisonedScript],
    [selectedHarness, trustedScript],
  ] as const) {
    const scriptsDir = path.join(dir, "scripts");
    mkdirSync(path.join(scriptsDir, "e2e"), { recursive: true });
    writeFileSync(path.join(dir, "marker.cjs"), script);
    for (const leaf of [
      "e2e/gateway-concurrency-docker.sh",
      "test-live-models-docker.sh",
      "test-live-build-docker.sh",
    ]) {
      writeFileSync(
        path.join(scriptsDir, leaf),
        `#!/usr/bin/env bash\nexec node ${quote(path.join(dir, "marker.cjs"))} ${leaf === "test-live-build-docker.sh" ? "live-build" : ""}\n`,
      );
    }
    writeJson(path.join(dir, "package.json"), {
      name: "openclaw",
      version,
      ...(corepack && {
        packageManager: dir === selectedHarness ? "pnpm@11.22.0" : "pnpm@12.0.0",
      }),
      scripts:
        dir === target && missingTargetScript
          ? {}
          : {
              "test:docker:gateway-network": "node marker.cjs",
              "test:docker:e2e-build": "node marker.cjs package-image",
              "test:docker:cleanup": "node marker.cjs cleanup",
              "test:docker:all": `node ${quote(path.join(harness, "scripts/test-docker-all.mjs"))}`,
            },
    });
    // Keep pnpm in this miniature workspace, away from the host repo's toolchain pin.
    writeFileSync(path.join(dir, "pnpm-workspace.yaml"), "packages: []\n");
  }
  execFileSync("git", ["init", "-q"], { cwd: target });
  execFileSync("git", ["add", "package.json"], { cwd: target });
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "candidate"],
    { cwd: target },
  );
  const selectedSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: target,
    encoding: "utf8",
  }).trim();
  const registry = path.join(root, "frozen registry");
  mkdirSync(registry);
  writeJson(path.join(packageDir, "package.json"), { name: "@openclaw/codex", version });
  const pluginTarball = path.join(registry, "codex.tgz");
  execFileSync("tar", ["-czf", pluginTarball, "-C", path.dirname(packageDir), "package"]);
  const registryManifest = path.join(registry, "prepublish-plugin-registry.json");
  writeJson(registryManifest, {
    schema: "openclaw.prepublish-plugin-registry/v1",
    schemaVersion: 1,
    sourceSha: selectedSha,
    candidateVersion: version,
    packages: [
      {
        name: "@openclaw/codex",
        version,
        tarball: "codex.tgz",
        sha256: createHash("sha256").update(readFileSync(pluginTarball)).digest("hex"),
      },
    ],
  });
  const registrySha256 = createHash("sha256").update(readFileSync(registryManifest)).digest("hex");
  const pnpm = execFileSync("bash", ["-c", "command -v pnpm"], { encoding: "utf8" }).trim();
  const pinnedPnpm = path.join(root, "pinned '$& pnpm wrapper");
  // Corepack Engine.executePackageManagerRequest resolves findProjectSpec(cwd)
  // before runVersion forwards argv. pnpm then checks its effective project's pin.
  // Model only that offline boundary; package scripts still execute as real children.
  writeFileSync(
    pinnedPnpm,
    corepack
      ? `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const manifest = (cwd) => JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
const selected = manifest(process.cwd()).packageManager;
const args = process.argv.slice(2);
const cwd = args[0] === '--dir' ? args.splice(0, 2)[1] : process.cwd();
const project = manifest(cwd);
fs.appendFileSync(${JSON.stringify(toolchainMarker)}, JSON.stringify({ cwd: process.cwd(), selected, required: project.packageManager }) + '\\n');
if (selected !== project.packageManager) {
  console.error('ERR_PNPM_BAD_PM_VERSION: Corepack selected ' + selected + ' before --dir; project requires ' + project.packageManager);
  process.exit(1);
}
const result = spawnSync(project.scripts[args[0]], { cwd, shell: true, stdio: 'inherit' });
process.exit(result.status ?? 1);
`
      : `#!/usr/bin/env bash\nexec ${quote(pnpm)} "$@"\n`,
  );
  chmodSync(pinnedPnpm, 0o755);
  return {
    root,
    target,
    harness,
    selectedHarness,
    marker,
    poison,
    tarball,
    sha256,
    selectedSha,
    pinnedPnpm,
    registry,
    registrySha256,
    toolchainMarker,
  };
}

function runFixture(
  fixture: ReturnType<typeof setupFixture>,
  mode: string,
  lanes = laneNames,
  options: { args?: string[]; env?: NodeJS.ProcessEnv } = {},
) {
  const logDir = path.join(fixture.root, "logs");
  const result = spawnSync(
    process.execPath,
    [path.join(fixture.harness, "scripts/test-docker-all.mjs"), ...(options.args ?? [])],
    {
      cwd: fixture.target,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        OPENCLAW_DOCKER_ALL_BUILD: "0",
        OPENCLAW_DOCKER_ALL_PREFLIGHT: "0",
        OPENCLAW_DOCKER_ALL_TIMINGS: "0",
        OPENCLAW_DOCKER_ALL_START_STAGGER_MS: "0",
        OPENCLAW_DOCKER_ALL_LIVE_RETRIES: "0",
        OPENCLAW_DOCKER_ALL_LANES: lanes.join(","),
        OPENCLAW_DOCKER_ALL_LOG_DIR: logDir,
        OPENCLAW_DOCKER_ALL_PNPM_COMMAND: fixture.pinnedPnpm,
        OPENCLAW_DOCKER_E2E_REPO_ROOT: mode === "local" ? "" : fixture.target,
        OPENCLAW_DOCKER_E2E_TRUSTED_HARNESS_DIR:
          mode === "override" ? path.relative(fixture.target, fixture.selectedHarness) : "",
        OPENCLAW_DOCKER_E2E_SELECTED_SHA: fixture.selectedSha,
        OPENCLAW_CURRENT_PACKAGE_TGZ: fixture.tarball,
        OPENCLAW_CURRENT_PACKAGE_VERSION: "2026.8.1",
        OPENCLAW_CURRENT_PACKAGE_SHA256: fixture.sha256,
        OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: fixture.registry,
        OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION: "2026.8.1",
        OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256: fixture.registrySha256,
        ...options.env,
      },
    },
  );
  return { result, logDir };
}

describe("Docker scheduler trusted harness execution", () => {
  posixIt.each(["split", "override", "local"] as const)(
    "executes current scripts with the frozen candidate in %s mode",
    (mode) => {
      const fixture = setupFixture(mode, false, true);
      const { result, logDir } = runFixture(fixture, mode, laneNames, {
        env: {
          OPENCLAW_DOCKER_ALL_PNPM_COMMAND: path.relative(fixture.target, fixture.pinnedPnpm),
          OPENCLAW_DOCKER_CACHE_HOME_DIR: "relative cache",
          OPENCLAW_DOCKER_CLI_TOOLS_DIR: "relative tools",
        },
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(existsSync(fixture.poison)).toBe(false);
      const calls = readFileSync(fixture.marker, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls.map((call) => call.lane).sort()).toEqual([...laneNames].sort());
      for (const call of calls) {
        expect(call).toMatchObject({
          target: fixture.target,
          harness: fixture.selectedHarness,
          liveTarget: fixture.target,
          package: fixture.tarball,
          sha256: fixture.sha256,
          selectedSha: fixture.selectedSha,
          registry: fixture.registry,
          registryVersion: "2026.8.1",
          registrySha256: fixture.registrySha256,
          cache: path.join(fixture.target, "relative cache"),
          tools: path.join(fixture.target, "relative tools"),
        });
      }
      expect(calls.find((call) => call.lane === "gateway-network").cwd).toBe(
        fixture.selectedHarness,
      );
      expect(calls.find((call) => call.lane === "live-models").cwd).toBe(fixture.target);
      expect(calls.find((call) => call.lane === "gateway-concurrency").cwd).toBe(fixture.target);
      const summary = JSON.parse(readFileSync(path.join(logDir, "summary.json"), "utf8"));
      expect(summary.status).toBe("passed");
      expect(summary.lanes).toHaveLength(3);
      expect(JSON.parse(readFileSync(fixture.toolchainMarker, "utf8").trim())).toEqual({
        cwd: fixture.selectedHarness,
        selected: "pnpm@11.22.0",
        required: "pnpm@11.22.0",
      });
      if (mode === "override") {
        const rerun = spawnSync(
          "bash",
          [
            "-c",
            summary.lanes.find((lane: { name: string }) => lane.name === "gateway-network")
              .rerunCommand,
          ],
          {
            cwd: fixture.target,
            encoding: "utf8",
            timeout: 30_000,
            env: {
              ...process.env,
              OPENCLAW_DOCKER_ALL_LOG_DIR: path.join(fixture.root, "rerun logs"),
              OPENCLAW_DOCKER_ALL_TIMINGS: "0",
            },
          },
        );
        expect(rerun.status, rerun.stdout + rerun.stderr).toBe(0);
        const rerunCall = JSON.parse(
          readFileSync(fixture.marker, "utf8").trim().split("\n").at(-1)!,
        );
        expect(rerunCall).toMatchObject({
          lane: "gateway-network",
          cwd: fixture.selectedHarness,
          target: fixture.target,
          package: fixture.tarball,
          sha256: fixture.sha256,
          selectedSha: fixture.selectedSha,
          registry: fixture.registry,
          registrySha256: fixture.registrySha256,
        });
      }
    },
  );

  posixIt("runs a trusted package script absent from the frozen target", () => {
    const fixture = setupFixture("split", true);
    const { result } = runFixture(fixture, "split", ["gateway-network"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(existsSync(fixture.poison)).toBe(false);
    expect(JSON.parse(readFileSync(fixture.marker, "utf8").trim()).lane).toBe("gateway-network");
  });
  posixIt("keeps preflight on the target while shared builds use trusted scripts", () => {
    const fixture = setupFixture("split");
    const bin = path.join(fixture.root, "bin");
    mkdirSync(bin);
    const dockerLog = path.join(fixture.root, "docker.jsonl");
    const docker = path.join(bin, "docker");
    writeFileSync(
      docker,
      `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(dockerLog)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
console.log('fixture-docker');
`,
    );
    chmodSync(docker, 0o755);
    const { result } = runFixture(fixture, "split", laneNames, {
      env: {
        OPENCLAW_DOCKER_ALL_BUILD: "1",
        OPENCLAW_DOCKER_ALL_PREFLIGHT: "1",
        OPENCLAW_DOCKER_ALL_PREFLIGHT_CLEANUP: "0",
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const dockerCalls = readFileSync(dockerLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(dockerCalls.map((call) => call.args[0])).toEqual(["version", "run"]);
    expect(dockerCalls.every((call) => call.cwd === fixture.target)).toBe(true);
    const builds = readFileSync(fixture.marker, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((call) => call.phase);
    expect(builds).toEqual([
      expect.objectContaining({
        phase: "live-build",
        cwd: fixture.target,
        liveTarget: fixture.target,
      }),
      expect.objectContaining({
        phase: "package-image",
        cwd: fixture.selectedHarness,
        target: fixture.target,
        package: fixture.tarball,
      }),
    ]);
  });

  posixIt("prepares target bytes through the trusted packer before any Docker work", () => {
    const fixture = setupFixture("split");
    const packedMarker = path.join(fixture.root, "packed-source");
    const targetPacker = path.join(fixture.target, "scripts/package-openclaw-for-docker.mjs");
    writeFileSync(targetPacker, "process.exit(47);\n");
    writeFileSync(
      path.join(fixture.harness, "scripts/package-openclaw-for-docker.mjs"),
      `
import fs from 'node:fs'; import path from 'node:path';
const value = (name) => process.argv[process.argv.indexOf(name) + 1];
fs.writeFileSync(${JSON.stringify(packedMarker)}, value('--source-dir'));
fs.mkdirSync(value('--output-dir'), { recursive: true });
fs.copyFileSync(${JSON.stringify(fixture.tarball)}, path.join(value('--output-dir'), value('--output-name')));
`,
    );
    execFileSync("git", ["add", "."], { cwd: fixture.target });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        "fixture packers",
      ],
      { cwd: fixture.target },
    );
    const manifestPath = path.join(fixture.root, "candidate.json");
    const { result } = runFixture(fixture, "split", ["gateway-network"], {
      args: [`--prepare-only=${manifestPath}`],
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(packedMarker, "utf8")).toBe(fixture.target);
    expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({
      candidate: { package: { sha256: fixture.sha256, version: "2026.8.1" } },
    });
    expect(existsSync(fixture.marker)).toBe(false);
  });
});
