// Exact package assertions shared by Codex release install scenarios.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assertPathInside, findPackageJson, readJson } from "./codex-install-utils.mjs";

const EXPECTED_CODEX_VERSION = "0.149.0";
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

function recordEvidence(evidence) {
  for (const [key, value] of Object.entries(evidence)) {
    process.stdout.write(`[codex-release] ${key}=${value}\n`);
  }
}

export function assertCodexReleasePackageContract(params) {
  const platform = params.platform ?? process.platform;
  const arch = params.arch ?? process.arch;
  const target = CODEX_PLATFORM_TARGETS.get(`${platform}:${arch}`);
  if (!target) {
    throw new Error(`unsupported Codex release platform: ${platform}/${arch}`);
  }

  const pluginPackage = readJson(params.pluginPackageJson);
  const expectedDependency = pluginPackage.dependencies?.["@openai/codex"];
  if (expectedDependency !== EXPECTED_CODEX_VERSION) {
    throw new Error(
      `@openclaw/codex must depend on @openai/codex ${EXPECTED_CODEX_VERSION}; found ${String(expectedDependency)}`,
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
  if (codexPackage.version !== EXPECTED_CODEX_VERSION) {
    throw new Error(
      `installed @openai/codex version mismatch: expected ${EXPECTED_CODEX_VERSION}, got ${String(codexPackage.version)}`,
    );
  }
  const expectedAliasSpec = `npm:@openai/codex@${EXPECTED_CODEX_VERSION}-${platform}-${arch}`;
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
  const expectedPlatformVersion = `${EXPECTED_CODEX_VERSION}-${platform}-${arch}`;
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
  if (versionMatch?.[1] !== EXPECTED_CODEX_VERSION) {
    throw new Error(
      `managed Codex CLI version mismatch: expected ${EXPECTED_CODEX_VERSION}, got ${JSON.stringify(stdout)}`,
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
    recordEvidence(evidence);
  }
  return { codexBin, evidence };
}
