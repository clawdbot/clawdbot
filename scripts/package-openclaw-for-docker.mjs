#!/usr/bin/env node
// Builds the OpenClaw package artifact used by Docker E2E.
// The script owns the build/inventory/pack sequence so local scheduler, shell
// helpers, and GitHub Actions all prepare the exact same npm tarball.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = {
    outputDir: "",
    outputName: "",
    skipBuild: false,
    sourceDir: ROOT_DIR,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output-dir") {
      options.outputDir = argv[(index += 1)] ?? "";
    } else if (arg?.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length);
    } else if (arg === "--output-name") {
      options.outputName = argv[(index += 1)] ?? "";
    } else if (arg?.startsWith("--output-name=")) {
      options.outputName = arg.slice("--output-name=".length);
    } else if (arg === "--skip-build") {
      options.skipBuild = true;
    } else if (arg === "--source-dir") {
      options.sourceDir = argv[(index += 1)] ?? "";
    } else if (arg?.startsWith("--source-dir=")) {
      options.sourceDir = arg.slice("--source-dir=".length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(process.stderr, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      if (status === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with ${status ?? signal}`));
    });
  });
}

async function runCapture(command, args, cwd) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.pipe(process.stderr, { end: false });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      if (status === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with ${status ?? signal}`));
    });
  });
}

async function newestOpenClawTarball(outputDir, packOutput) {
  let fromOutput = "";
  for (const line of packOutput.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (/^openclaw-.*\.tgz$/u.test(trimmed)) {
      fromOutput = trimmed;
    }
  }
  if (fromOutput) {
    return path.join(outputDir, fromOutput);
  }

  const entries = await fs.readdir(outputDir);
  const packed = entries
    .filter((entry) => /^openclaw-.*\.tgz$/u.test(entry))
    .toSorted()
    .at(-1);
  if (!packed) {
    throw new Error(`missing packed OpenClaw tarball in ${outputDir}`);
  }
  return path.join(outputDir, packed);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sourceDir = path.resolve(ROOT_DIR, options.sourceDir || ROOT_DIR);
  const outputDir = path.resolve(
    ROOT_DIR,
    options.outputDir || path.join(".artifacts", "docker-e2e-package"),
  );
  await fs.mkdir(outputDir, { recursive: true });

  if (!options.skipBuild) {
    console.error("==> Building OpenClaw package artifacts");
    await run("pnpm", ["build"], sourceDir);
  }

  console.error("==> Writing OpenClaw package inventory");
  await run(
    "node",
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "const { writePackageDistInventory } = await import('./src/infra/package-dist-inventory.ts'); await writePackageDistInventory(process.cwd());",
    ],
    sourceDir,
  );

  console.error("==> Packing OpenClaw package");
  const packOutput = await runCapture(
    "npm",
    ["pack", "--silent", "--ignore-scripts", "--pack-destination", outputDir],
    sourceDir,
  );
  let tarball = await newestOpenClawTarball(outputDir, packOutput);

  if (options.outputName) {
    const target = path.join(outputDir, options.outputName);
    if (target !== tarball) {
      await fs.rm(target, { force: true });
      await fs.rename(tarball, target);
      tarball = target;
    }
  }

  console.error("==> Checking OpenClaw package tarball");
  await run(
    "node",
    [path.join(ROOT_DIR, "scripts/check-openclaw-package-tarball.mjs"), tarball],
    sourceDir,
  );

  process.stdout.write(`${tarball}\n`);
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
