import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveNpmJsonEntries } from "./lib/npm-json-output.mts";
import {
  listPublishablePluginPackages,
  resolveCandidatePluginPackageDir,
  type PublishablePluginPackage,
} from "./lib/plugin-npm-security-scan.mts";
import { resolveNpmRunner } from "./npm-runner.mts";
import {
  inspectPackageTarballBytes,
  readBoundedRegularFile,
} from "./plugin-publication-artifact.mjs";

const MAX_PACK_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_TARBALL_BYTES = 128 * 1024 * 1024;
const PACK_TIMEOUT_MS = 20 * 60 * 1000;

type ParsedArgs = {
  candidateRoot: string;
  candidateSha: string;
  command: "plan" | "prepare";
  extensionId: string;
  githubOutput: string;
  outputDir: string;
  packageDir: string;
  packageName: string;
  toolingSha: string;
};

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0];
  if (command !== "plan" && command !== "prepare") {
    throw new Error("Expected plugin npm security prepare command: plan or prepare.");
  }
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || values.has(name)) {
      throw new Error(`Invalid plugin npm security prepare argument near ${name}.`);
    }
    values.set(name, value);
  }
  const candidateRoot = values.get("--candidate-root") ?? "";
  if (!candidateRoot) {
    throw new Error("--candidate-root is required.");
  }
  const parsed: ParsedArgs = {
    candidateRoot: resolve(candidateRoot),
    candidateSha: values.get("--candidate-sha") ?? "",
    command,
    extensionId: values.get("--extension-id") ?? "",
    githubOutput: values.get("--github-output") ?? "",
    outputDir: values.get("--output-dir") ?? "",
    packageDir: values.get("--package-dir") ?? "",
    packageName: values.get("--package-name") ?? "",
    toolingSha: values.get("--tooling-sha") ?? "",
  };
  if (command === "plan") {
    if (!parsed.githubOutput) {
      throw new Error("plan requires --github-output.");
    }
    return parsed;
  }
  if (
    !/^[0-9a-f]{40}$/u.test(parsed.candidateSha) ||
    !/^[0-9a-f]{40}$/u.test(parsed.toolingSha) ||
    !/^[a-z0-9][a-z0-9._-]*$/u.test(parsed.extensionId) ||
    parsed.packageDir !== `extensions/${parsed.extensionId}` ||
    !parsed.packageName ||
    !parsed.outputDir
  ) {
    throw new Error("prepare received an invalid package or commit identity.");
  }
  parsed.outputDir = resolve(parsed.outputDir);
  return parsed;
}

function relativePackage(plugin: PublishablePluginPackage, candidateRoot: string) {
  const packageDir = relative(candidateRoot, plugin.packageDir).split(sep).join("/");
  if (packageDir !== `extensions/${plugin.extensionId}`) {
    throw new Error(`${plugin.packageName}: package directory escaped the candidate checkout.`);
  }
  return {
    extensionId: plugin.extensionId,
    packageDir,
    packageName: plugin.packageName,
    packageVersion: plugin.packageVersion,
  };
}

async function planPackages(args: ParsedArgs): Promise<void> {
  const candidateRoot = realpathSync(args.candidateRoot);
  const packages = (await listPublishablePluginPackages(candidateRoot)).map((plugin) =>
    relativePackage(plugin, candidateRoot),
  );
  appendFileSync(args.githubOutput, `packages_json=${JSON.stringify(packages)}\n`, "utf8");
}

function gitSha(root: string): string {
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function parsePackOutput(stdout: string): Array<Record<string, unknown>> {
  const raw = stdout.trim();
  for (let index = raw.length - 1; index >= 0; index -= 1) {
    if (raw[index] !== "[" && raw[index] !== "{") {
      continue;
    }
    try {
      const entries = resolveNpmJsonEntries(JSON.parse(raw.slice(index)));
      if (entries.length > 0) {
        return entries as Array<Record<string, unknown>>;
      }
    } catch {
      // npm can print bundled dependency diagnostics before its JSON result.
    }
  }
  throw new Error("Trusted plugin packaging did not emit npm pack JSON.");
}

async function preparePackage(args: ParsedArgs): Promise<void> {
  const toolingRoot = realpathSync(process.cwd());
  const candidateRoot = realpathSync(args.candidateRoot);
  if (gitSha(toolingRoot) !== args.toolingSha || gitSha(candidateRoot) !== args.candidateSha) {
    throw new Error("Plugin packaging checkout identity differs from the trusted plan.");
  }
  const packages = await listPublishablePluginPackages(candidateRoot);
  const selected = packages.find(
    (plugin) =>
      plugin.extensionId === args.extensionId &&
      plugin.packageName === args.packageName &&
      relativePackage(plugin, candidateRoot).packageDir === args.packageDir,
  );
  if (!selected) {
    throw new Error("Selected plugin package is absent from the trusted package plan.");
  }
  resolveCandidatePluginPackageDir(candidateRoot, args.extensionId);
  if (existsSync(args.outputDir)) {
    if (readdirSync(args.outputDir).length !== 0) {
      throw new Error("Plugin security artifact output directory must be empty.");
    }
  } else {
    mkdirSync(args.outputDir, { recursive: true });
  }

  // This is supplemental inert checked-in npm input, never a final or
  // publication artifact. Exact-byte scanning is a future publisher redesign,
  // not a capability of this workflow.
  const npm = resolveNpmRunner({
    env: {
      CI: "1",
      HOME: tmpdir(),
      NODE_OPTIONS: "--max-old-space-size=512",
      NPM_CONFIG_AUDIT: "false",
      NPM_CONFIG_FUND: "false",
      NPM_CONFIG_GLOBALCONFIG: "/dev/null",
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
      NPM_CONFIG_PROVENANCE: "false",
      NPM_CONFIG_USERCONFIG: join(tmpdir(), "openclaw-plugin-security-empty-npmrc"),
      NPM_CONFIG_WORKSPACES: "false",
      PATH: process.env.PATH,
      TMPDIR: tmpdir(),
    },
    npmArgs: [
      "pack",
      "--json",
      "--ignore-scripts",
      "--workspaces=false",
      "--pack-destination",
      args.outputDir,
    ],
  });
  const result = spawnSync(npm.command, npm.args, {
    cwd: selected.packageDir,
    encoding: "utf8",
    env: npm.env,
    killSignal: "SIGKILL",
    maxBuffer: MAX_PACK_STDOUT_BYTES,
    shell: npm.shell,
    stdio: ["ignore", "pipe", "inherit"],
    timeout: PACK_TIMEOUT_MS,
    windowsVerbatimArguments: npm.windowsVerbatimArguments,
  });
  if (result.status !== 0 || result.signal || result.error) {
    throw new Error(`${selected.packageName}: trusted inert plugin pack failed.`);
  }
  const packEntries = parsePackOutput(result.stdout);
  if (packEntries.length !== 1) {
    throw new Error(`${selected.packageName}: npm pack returned an invalid result count.`);
  }
  const tarballName = packEntries[0]?.filename;
  if (
    typeof tarballName !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/u.test(tarballName) ||
    basename(tarballName) !== tarballName
  ) {
    throw new Error(`${selected.packageName}: npm pack returned an unsafe tarball name.`);
  }
  const tarballPath = join(args.outputDir, tarballName);
  const tarballBytes = readBoundedRegularFile(tarballPath, {
    label: "Prepared plugin tarball",
    maxBytes: MAX_TARBALL_BYTES,
  });
  const inspection = inspectPackageTarballBytes(tarballBytes, {
    maxArchiveBytes: MAX_TARBALL_BYTES,
  });
  if (
    inspection.packageManifest.name !== selected.packageName ||
    inspection.packageManifest.version !== selected.packageVersion
  ) {
    throw new Error(`${selected.packageName}: inert package input identity mismatch.`);
  }
  const artifactEntries = readdirSync(args.outputDir);
  if (artifactEntries.length !== 1 || artifactEntries[0] !== tarballName) {
    throw new Error(`${selected.packageName}: packaging produced unexpected artifact files.`);
  }
  const metadata = {
    artifactKind: "supplemental-inert-package-input",
    candidateSha: args.candidateSha,
    extensionId: selected.extensionId,
    packageDir: args.packageDir,
    packageName: selected.packageName,
    packageVersion: selected.packageVersion,
    schemaVersion: 1,
    tarballName,
    tarballSha256: inspection.tarballSha256,
    toolingSha: args.toolingSha,
  };
  writeFileSync(
    join(args.outputDir, "plugin-npm-security-artifact.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "plan") {
    await planPackages(args);
  } else {
    await preparePackage(args);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
