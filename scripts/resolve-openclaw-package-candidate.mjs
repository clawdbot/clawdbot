#!/usr/bin/env node
// Normalizes package-acceptance inputs into the tarball shape consumed by Docker E2E.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_NAME = "openclaw-current.tgz";
export const OPENCLAW_PACKAGE_SPEC_RE =
  /^openclaw@(alpha|beta|latest|[0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*(-[1-9][0-9]*|-(alpha|beta)\.[1-9][0-9]*)?)$/u;

function usage() {
  return `Usage: node scripts/resolve-openclaw-package-candidate.mjs --source <ref|npm|url|artifact> --output-dir <dir> [options]

Options:
  --package-spec <spec>       Published npm spec for source=npm.
  --package-ref <ref>         Trusted repo ref for source=ref.
  --package-url <url>         HTTPS tarball URL for source=url.
  --package-sha256 <sha256>   Expected tarball SHA-256 for source=url or source=artifact.
  --artifact-dir <dir>        Directory containing exactly one .tgz for source=artifact.
  --output-name <name>        Output tarball filename. Default: ${DEFAULT_OUTPUT_NAME}
  --metadata <file>           Write package metadata JSON.
  --github-output <file>      Append tarball, sha256, package name/version outputs.`;
}

export function parseArgs(argv) {
  const options = {
    artifactDir: "",
    githubOutput: "",
    metadata: "",
    outputDir: "",
    outputName: DEFAULT_OUTPUT_NAME,
    packageRef: "",
    packageSha256: "",
    packageSpec: "",
    packageUrl: "",
    source: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = (name) => {
      const value = argv[(index += 1)];
      if (value === undefined) {
        throw new Error(`${name} requires a value`);
      }
      return value;
    };
    if (arg === "--artifact-dir") {
      options.artifactDir = readValue(arg);
    } else if (arg === "--github-output") {
      options.githubOutput = readValue(arg);
    } else if (arg === "--metadata") {
      options.metadata = readValue(arg);
    } else if (arg === "--output-dir") {
      options.outputDir = readValue(arg);
    } else if (arg === "--output-name") {
      options.outputName = readValue(arg);
    } else if (arg === "--package-sha256") {
      options.packageSha256 = readValue(arg).toLowerCase();
    } else if (arg === "--package-ref") {
      options.packageRef = readValue(arg);
    } else if (arg === "--package-spec") {
      options.packageSpec = readValue(arg);
    } else if (arg === "--package-url") {
      options.packageUrl = readValue(arg);
    } else if (arg === "--source") {
      options.source = readValue(arg);
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

export function validateOpenClawPackageSpec(spec) {
  if (!OPENCLAW_PACKAGE_SPEC_RE.test(spec)) {
    throw new Error(
      `package_spec must be openclaw@alpha, openclaw@beta, openclaw@latest, or an exact OpenClaw release version; got: ${spec}`,
    );
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT_DIR,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    });
    let timedOut = false;
    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 5_000).unref?.();
          }, options.timeoutMs);
    timeout?.unref?.();
    let stdout = "";
    let stderr = "";
    if (options.capture) {
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
    }
    child.on("error", reject);
    child.on("close", (status, signal) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (timedOut) {
        reject(new Error(`${command} ${args.join(" ")} timed out after ${options.timeoutMs}ms`));
        return;
      }
      if (status === 0) {
        resolve(stdout);
        return;
      }
      const detail = stderr.trim() ? `\n${stderr.trim()}` : "";
      reject(new Error(`${command} ${args.join(" ")} failed with ${status ?? signal}${detail}`));
    });
  });
}

async function walkFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(absolute)));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

async function sha256(file) {
  const hash = createHash("sha256");
  const handle = await fs.open(file, "r");
  try {
    for await (const chunk of handle.createReadStream()) {
      hash.update(chunk);
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function assertSha256(value) {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`package_sha256 must be a lowercase or uppercase 64-character SHA-256 digest`);
  }
}

async function assertExpectedSha256(file, expected) {
  if (!expected) {
    return await sha256(file);
  }
  assertSha256(expected);
  const actual = await sha256(file);
  if (actual !== expected.toLowerCase()) {
    throw new Error(`package SHA-256 mismatch: expected ${expected}, got ${actual}`);
  }
  return actual;
}

async function findSingleTarball(dir) {
  const files = (await walkFiles(path.resolve(ROOT_DIR, dir)))
    .filter((file) => /\.t(?:ar\.)?gz$/u.test(path.basename(file)))
    .toSorted((a, b) => a.localeCompare(b));
  if (files.length !== 1) {
    throw new Error(
      `source=artifact requires exactly one .tgz under ${dir}; found ${files.length}: ${files.join(", ")}`,
    );
  }
  return files[0];
}

export async function readArtifactPackageCandidateMetadata(dir) {
  const metadataPath = path.join(path.resolve(ROOT_DIR, dir), "package-candidate.json");
  let raw = "";
  try {
    raw = await fs.readFile(metadataPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }
    throw error;
  }
  const parsed = JSON.parse(raw);
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`artifact package-candidate.json must contain a JSON object`);
  }
  return parsed;
}

async function revParseTrustedInputRef(ref) {
  const candidates = [ref, `refs/remotes/origin/${ref}`, `refs/tags/${ref}`];
  for (const candidate of candidates) {
    const resolved = await run("git", ["rev-parse", "--verify", `${candidate}^{commit}`], {
      capture: true,
    }).then(
      (value) => value.trim(),
      () => "",
    );
    if (resolved) {
      return resolved;
    }
  }
  throw new Error(`package_ref does not resolve to a commit: ${ref}`);
}

async function resolveTrustedRepoRef(ref) {
  if (!ref || ref.trim() === "" || ref.startsWith("-")) {
    throw new Error(
      `package_ref must be a branch, tag, or full commit SHA; got: ${ref || "<empty>"}`,
    );
  }

  await run("git", ["fetch", "--no-tags", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
  await run("git", ["fetch", "--tags", "origin", "+refs/tags/*:refs/tags/*"]);

  const selectedSha = await revParseTrustedInputRef(ref);
  const isMainAncestor = await run("git", [
    "merge-base",
    "--is-ancestor",
    selectedSha,
    "refs/remotes/origin/main",
  ]).then(
    () => true,
    () => false,
  );
  if (isMainAncestor) {
    return { selectedSha, trustedReason: "main-ancestor" };
  }

  const releaseTags = (await run("git", ["tag", "--points-at", selectedSha], { capture: true }))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (releaseTags.some((tag) => tag.startsWith("v"))) {
    return { selectedSha, trustedReason: "release-tag" };
  }

  const containingBranches = (
    await run(
      "git",
      [
        "for-each-ref",
        "--format=%(refname:short)",
        "--contains",
        selectedSha,
        "refs/remotes/origin",
      ],
      { capture: true },
    )
  )
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (containingBranches.some((branch) => branch.startsWith("origin/"))) {
    return { selectedSha, trustedReason: "repository-branch-history" };
  }

  throw new Error(
    `package_ref ${ref} resolved to ${selectedSha}, which is not reachable from an OpenClaw branch or release tag`,
  );
}

async function preparePackageSourceWorktree(ref) {
  const { selectedSha, trustedReason } = await resolveTrustedRepoRef(ref);
  const sourceDir = path.join(
    process.env.RUNNER_TEMP || os.tmpdir(),
    `openclaw-package-source-${process.pid}`,
  );
  await fs.rm(sourceDir, { recursive: true, force: true });
  await run("git", ["worktree", "add", "--detach", sourceDir, selectedSha]);
  return { selectedSha, sourceDir, trustedReason };
}

async function installPackageSourceDeps(sourceDir) {
  await run(
    "pnpm",
    [
      "install",
      "--frozen-lockfile",
      "--ignore-scripts=false",
      "--config.engine-strict=false",
      "--config.enable-pre-post-scripts=true",
    ],
    { cwd: sourceDir },
  );
}

async function moveNewestPackedTarball(outputDir, packOutput, outputName) {
  let filename = "";
  try {
    const parsed = JSON.parse(packOutput);
    if (Array.isArray(parsed)) {
      filename = parsed.find((entry) => typeof entry?.filename === "string")?.filename ?? "";
    }
  } catch {}
  if (!filename) {
    for (const line of packOutput.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (/^openclaw-.*\.tgz$/u.test(trimmed)) {
        filename = trimmed;
      }
    }
  }
  if (!filename) {
    const entries = await fs.readdir(outputDir);
    filename = entries
      .filter((entry) => /^openclaw-.*\.tgz$/u.test(entry))
      .toSorted((a, b) => a.localeCompare(b))
      .at(-1);
  }
  if (!filename) {
    throw new Error(`npm pack produced no OpenClaw tarball in ${outputDir}`);
  }
  const packed = path.join(outputDir, filename);
  const target = path.join(outputDir, outputName);
  if (packed !== target) {
    await fs.rm(target, { force: true });
    await fs.rename(packed, target);
  }
  return target;
}

async function downloadUrl(url, target) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error(`package_url must use https: ${url}`);
  }
  const response = await fetch(parsed);
  if (!response.ok || !response.body) {
    throw new Error(`failed to download package_url: HTTP ${response.status}`);
  }
  await pipeline(response.body, createWriteStream(target));
}

async function readPackageJson(tarball) {
  const raw = await run("tar", ["-xOf", tarball, "package/package.json"], { capture: true });
  const pkg = JSON.parse(raw);
  return {
    name: typeof pkg.name === "string" ? pkg.name : "",
    version: typeof pkg.version === "string" ? pkg.version : "",
  };
}

async function appendGithubOutputs(file, outputs) {
  if (!file) {
    return;
  }
  const body = Object.entries(outputs)
    .map(([key, value]) => `${key}=${String(value).replace(/\n/gu, " ")}`)
    .join("\n");
  await fs.appendFile(file, `${body}\n`);
}

async function resolveCandidate(options) {
  const outputDir = path.resolve(ROOT_DIR, options.outputDir);
  const target = path.join(outputDir, options.outputName || DEFAULT_OUTPUT_NAME);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.rm(target, { force: true });
  let packageRef = "";
  let packageSourceSha = "";
  let packageTrustedReason = "";
  let packageWorktreeDir = "";
  let artifactMetadata = {};

  try {
    if (options.source === "ref") {
      packageRef = options.packageRef || "main";
      const packageSource = await preparePackageSourceWorktree(packageRef);
      packageWorktreeDir = packageSource.sourceDir;
      packageSourceSha = packageSource.selectedSha;
      packageTrustedReason = packageSource.trustedReason;
      await installPackageSourceDeps(packageSource.sourceDir);
      await run("node", [
        "scripts/package-openclaw-for-docker.mjs",
        "--source-dir",
        packageSource.sourceDir,
        "--output-dir",
        outputDir,
        "--output-name",
        options.outputName || DEFAULT_OUTPUT_NAME,
      ]);
    } else if (options.source === "npm") {
      validateOpenClawPackageSpec(options.packageSpec);
      const packOutput = await run(
        "npm",
        [
          "pack",
          options.packageSpec,
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          outputDir,
        ],
        { capture: true },
      );
      await moveNewestPackedTarball(
        outputDir,
        packOutput,
        options.outputName || DEFAULT_OUTPUT_NAME,
      );
    } else if (options.source === "url") {
      if (!options.packageUrl) {
        throw new Error("source=url requires --package-url");
      }
      if (!options.packageSha256) {
        throw new Error("source=url requires --package-sha256");
      }
      await downloadUrl(options.packageUrl, target);
    } else if (options.source === "artifact") {
      if (!options.artifactDir) {
        throw new Error("source=artifact requires --artifact-dir");
      }
      artifactMetadata = await readArtifactPackageCandidateMetadata(options.artifactDir);
      packageRef =
        typeof artifactMetadata.packageRef === "string" ? artifactMetadata.packageRef : "";
      packageSourceSha =
        typeof artifactMetadata.packageSourceSha === "string"
          ? artifactMetadata.packageSourceSha
          : "";
      packageTrustedReason =
        typeof artifactMetadata.packageTrustedReason === "string"
          ? artifactMetadata.packageTrustedReason
          : "";
      const input = await findSingleTarball(options.artifactDir);
      await fs.copyFile(input, target);
    } else {
      throw new Error(`source must be one of: ref, npm, url, artifact. Got: ${options.source}`);
    }
  } finally {
    if (packageWorktreeDir) {
      await run("git", ["worktree", "remove", "--force", packageWorktreeDir]).catch(() => {});
    }
  }

  const artifactSha256 = typeof artifactMetadata.sha256 === "string" ? artifactMetadata.sha256 : "";
  const digest = await assertExpectedSha256(target, options.packageSha256 || artifactSha256);
  console.error(`Checking OpenClaw package tarball: ${target}`);
  const checkStartedAt = Date.now();
  await run("node", ["scripts/check-openclaw-package-tarball.mjs", target], {
    timeoutMs: 5 * 60 * 1000,
  });
  console.error(
    `OpenClaw package tarball check finished in ${Math.round((Date.now() - checkStartedAt) / 1000)}s`,
  );
  const pkg = await readPackageJson(target);
  const metadata = {
    name: pkg.name,
    packageRef,
    packageSpec: options.packageSpec || "",
    packageSourceSha,
    packageTrustedReason,
    sha256: digest,
    source: options.source,
    tarball: path.relative(ROOT_DIR, target),
    version: pkg.version,
  };

  if (pkg.name !== "openclaw") {
    throw new Error(`package candidate must be named "openclaw"; got: ${pkg.name || "<missing>"}`);
  }
  if (!pkg.version) {
    throw new Error("package candidate package.json has no version");
  }

  if (options.metadata) {
    await fs.mkdir(path.dirname(path.resolve(ROOT_DIR, options.metadata)), { recursive: true });
    await fs.writeFile(
      path.resolve(ROOT_DIR, options.metadata),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
  }
  await appendGithubOutputs(options.githubOutput, {
    package_name: pkg.name,
    package_source_sha: packageSourceSha,
    package_version: pkg.version,
    sha256: digest,
    tarball: metadata.tarball,
  });
  return metadata;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.outputDir) {
    throw new Error("--output-dir is required");
  }
  const metadata = await resolveCandidate(options);
  console.log(JSON.stringify(metadata, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exit(1);
  });
}
