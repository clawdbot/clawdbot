// Exact package assertions shared by Codex release install scenarios.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assertPathInside, findPackageJson, readJson } from "./codex-install-utils.mjs";

const CODEX_PLATFORM_TARGETS = new Map([
  ["linux:x64", { alias: "@openai/codex-linux-x64", os: "linux", cpu: "x64" }],
  ["linux:arm64", { alias: "@openai/codex-linux-arm64", os: "linux", cpu: "arm64" }],
  ["darwin:x64", { alias: "@openai/codex-darwin-x64", os: "darwin", cpu: "x64" }],
  ["darwin:arm64", { alias: "@openai/codex-darwin-arm64", os: "darwin", cpu: "arm64" }],
  ["win32:x64", { alias: "@openai/codex-win32-x64", os: "win32", cpu: "x64" }],
  ["win32:arm64", { alias: "@openai/codex-win32-arm64", os: "win32", cpu: "arm64" }],
]);

function exactStringArray(value, expected) {
  return Array.isArray(value) && value.length === 1 && value[0] === expected;
}

export function assertCodexReleasePackageContract(params) {
  const platform = params.platform ?? process.platform;
  const arch = params.arch ?? process.arch;
  const target = CODEX_PLATFORM_TARGETS.get(`${platform}:${arch}`);
  if (!target) {
    throw new Error(`unsupported Codex release platform: ${platform}/${arch}`);
  }

  // The lane mounts candidate metadata separately from the trusted harness checkout.
  const candidate = readJson("/tmp/openclaw-candidate-codex-package.json");
  const expectedVersion = candidate.dependencies?.["@openai/codex"];
  const pluginPackage = readJson(params.pluginPackageJson);
  const dependency = pluginPackage.dependencies?.["@openai/codex"];
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(expectedVersion) || dependency !== expectedVersion) {
    throw new Error(
      `@openclaw/codex must depend on @openai/codex ${expectedVersion}; found ${String(dependency)}`,
    );
  }
  const requiredPlatformPackages = pluginPackage.openclaw?.install?.requiredPlatformPackages;
  if (
    !Array.isArray(requiredPlatformPackages) ||
    !requiredPlatformPackages.includes(target.alias)
  ) {
    throw new Error(
      `@openclaw/codex manifest does not require current platform alias ${target.alias}`,
    );
  }

  assertPathInside(params.managedRoot, params.codexPackageJson, "@openai/codex dependency");
  const codexPackage = readJson(params.codexPackageJson);
  if (codexPackage.version !== expectedVersion) {
    throw new Error(
      `installed @openai/codex version mismatch: expected ${expectedVersion}, got ${String(codexPackage.version)}`,
    );
  }
  const expectedAliasSpec = `npm:@openai/codex@${expectedVersion}-${platform}-${arch}`;
  if (codexPackage.optionalDependencies?.[target.alias] !== expectedAliasSpec) {
    throw new Error(
      `@openai/codex current platform alias mismatch: expected ${target.alias}=${expectedAliasSpec}`,
    );
  }

  const platformPackageJson = findPackageJson(target.alias, params.packageRoots);
  if (!platformPackageJson) {
    throw new Error(`missing current Codex platform alias ${target.alias}`);
  }
  assertPathInside(params.managedRoot, platformPackageJson, "Codex platform package");
  const platformPackage = readJson(platformPackageJson);
  const expectedPlatformVersion = `${expectedVersion}-${platform}-${arch}`;
  if (platformPackage.version !== expectedPlatformVersion) {
    throw new Error(
      `installed ${target.alias} version mismatch: expected ${expectedPlatformVersion}, got ${String(platformPackage.version)}`,
    );
  }
  if (!exactStringArray(platformPackage.os, target.os)) {
    throw new Error(
      `installed ${target.alias} os mismatch: expected [${target.os}], got ${JSON.stringify(platformPackage.os)}`,
    );
  }
  if (!exactStringArray(platformPackage.cpu, target.cpu)) {
    throw new Error(
      `installed ${target.alias} cpu mismatch: expected [${target.cpu}], got ${JSON.stringify(platformPackage.cpu)}`,
    );
  }

  const codexBinPath =
    typeof codexPackage.bin === "string"
      ? codexPackage.bin
      : codexPackage.bin && typeof codexPackage.bin.codex === "string"
        ? codexPackage.bin.codex
        : undefined;
  if (!codexBinPath) {
    throw new Error(`@openai/codex package has no codex bin: ${params.codexPackageJson}`);
  }
  const codexBin = path.resolve(path.dirname(params.codexPackageJson), codexBinPath);
  if (!fs.existsSync(codexBin)) {
    throw new Error(`missing managed Codex binary: ${codexBin}`);
  }
  assertPathInside(params.managedRoot, codexBin, "managed Codex binary");
  const versionRun = spawnSync(process.execPath, [codexBin, "--version"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    timeout: 15_000,
    windowsHide: true,
  });
  const stdout = versionRun.stdout?.trim() ?? "";
  const stderr = versionRun.stderr?.trim() ?? "";
  if (versionRun.error || versionRun.status !== 0) {
    const failure = versionRun.error?.message ?? `exit status ${String(versionRun.status)}`;
    throw new Error(
      `managed Codex --version failed (${failure}): ${stderr || stdout || "no output"}`,
    );
  }
  const versionMatch = /^codex-cli\s+(\S+)$/u.exec(stdout);
  if (versionMatch?.[1] !== expectedVersion) {
    throw new Error(
      `managed Codex CLI version mismatch: expected ${expectedVersion}, got ${JSON.stringify(stdout)}`,
    );
  }

  const evidence = {
    packageVersion: codexPackage.version,
    cliVersion: versionMatch[1],
    platformAlias: target.alias,
    platformVersion: platformPackage.version,
    platformOs: target.os,
    platformCpu: target.cpu,
  };
  if (params.recordEvidence !== false) {
    for (const [key, value] of Object.entries(evidence)) {
      process.stdout.write(`[codex-release] ${key}=${value}\n`);
    }
  }
  return { codexBin, evidence };
}
