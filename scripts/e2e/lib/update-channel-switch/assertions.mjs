// Assertions for update-channel switch E2E scenarios.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { legacyPackageAcceptanceCompat } from "../package-compat.mjs";

const [command, ...args] = process.argv.slice(2);
const controlUiHtml = "<!doctype html><title>fixture</title>\n";

function usage() {
  console.error(
    "usage: assertions.mjs <prepare-git-fixture|write-control-ui|assert-update|assert-dry-run|assert-config-channel|assert-status-kind|assert-installed-version> [...]",
  );
  process.exit(2);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Runs inside the bare Docker E2E image, before package dependencies are installed.
// Keep this to the small pnpm-workspace.yaml surface the fixture mutates.
function findTopLevelBlock(lines, key) {
  const start = lines.findIndex((line) => new RegExp(`^${key}:\\s*(?:#.*)?$`).test(line));
  if (start === -1) {
    return null;
  }
  let end = start + 1;
  while (end < lines.length && !/^[A-Za-z0-9_-]+:\s*/.test(lines[end])) {
    end += 1;
  }
  return { start, end };
}

function parseYamlScalar(raw) {
  const trimmed = raw.trim();
  const withoutComment = trimmed.replace(/\s+#.*$/, "");
  if (withoutComment.startsWith('"') && withoutComment.endsWith('"')) {
    return withoutComment.slice(1, -1);
  }
  if (withoutComment.startsWith("'") && withoutComment.endsWith("'")) {
    return withoutComment.slice(1, -1);
  }
  return withoutComment;
}

function readWorkspacePatchedDependencies(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const block = findTopLevelBlock(lines, "patchedDependencies");
  if (!block) {
    return { patches: undefined };
  }

  const patches = {};
  for (const line of lines.slice(block.start + 1, block.end)) {
    const match = line.match(/^\s+(.+?):\s+(.+?)\s*$/);
    if (!match) {
      continue;
    }
    patches[parseYamlScalar(match[1])] = parseYamlScalar(match[2]);
  }
  return { patches };
}

function writeWorkspacePnpmConfig(file, keptPatches) {
  const original = fs.readFileSync(file, "utf8");
  const hadTrailingNewline = original.endsWith("\n");
  const lines = original.replace(/\n$/, "").split("\n");
  const patchBlock = findTopLevelBlock(lines, "patchedDependencies");

  if (patchBlock) {
    const nextLines = [];
    nextLines.push(...lines.slice(0, patchBlock.start));
    if (Object.keys(keptPatches).length > 0) {
      nextLines.push("patchedDependencies:");
      for (const [dependency, patchFile] of Object.entries(keptPatches)) {
        nextLines.push(`  ${JSON.stringify(dependency)}: ${JSON.stringify(patchFile)}`);
      }
    }
    nextLines.push(...lines.slice(patchBlock.end));
    lines.length = 0;
    lines.push(...nextLines);
  }

  const allowUnusedIndex = lines.findIndex((line) => /^allowUnusedPatches:\s*/.test(line));
  if (allowUnusedIndex === -1) {
    lines.push("allowUnusedPatches: true");
  } else {
    lines[allowUnusedIndex] = "allowUnusedPatches: true";
  }

  const minimumReleaseAgeIndex = lines.findIndex((line) => /^minimumReleaseAge:\s*/.test(line));
  if (minimumReleaseAgeIndex === -1) {
    lines.push("minimumReleaseAge: 0");
  } else {
    lines[minimumReleaseAgeIndex] = "minimumReleaseAge: 0";
  }

  fs.writeFileSync(file, `${lines.join("\n")}${hadTrailingNewline ? "\n" : ""}`);
}

function writeControlUi(root) {
  const file = path.join(root, "dist", "control-ui", "index.html");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, controlUiHtml);
}

function prepareGitFixture(root) {
  const packageJsonPath = path.join(root, "package.json");
  const packageJson = readJson(packageJsonPath);
  const pnpmWorkspacePath = path.join(root, "pnpm-workspace.yaml");
  const workspaceConfig = fs.existsSync(pnpmWorkspacePath)
    ? readWorkspacePatchedDependencies(pnpmWorkspacePath)
    : undefined;
  const pnpmConfig = workspaceConfig ? {} : { ...packageJson.pnpm };
  const patches = workspaceConfig?.patches ?? pnpmConfig.patchedDependencies;
  const keptPatches = {};
  if (patches && typeof patches === "object" && !Array.isArray(patches)) {
    const missing = [];
    for (const [dependency, patchFile] of Object.entries(patches)) {
      const exists =
        typeof patchFile === "string" &&
        fs.existsSync(path.resolve(path.dirname(packageJsonPath), patchFile));
      if (exists) {
        keptPatches[dependency] = patchFile;
      } else {
        missing.push(`${dependency} -> ${String(patchFile)}`);
      }
    }
    if (missing.length > 0 && !legacyPackageAcceptanceCompat(packageJson.version)) {
      throw new Error(
        `package ${packageJson.version} has missing pnpm patchedDependencies in package fixture: ${missing.join(", ")}`,
      );
    }
  }
  if (workspaceConfig) {
    writeWorkspacePnpmConfig(pnpmWorkspacePath, keptPatches);
  } else {
    pnpmConfig.allowUnusedPatches = true;
    pnpmConfig.minimumReleaseAge = 0;
    if (Object.keys(keptPatches).length > 0) {
      pnpmConfig.patchedDependencies = keptPatches;
    } else {
      delete pnpmConfig.patchedDependencies;
    }
    packageJson.pnpm = pnpmConfig;
  }
  const fixtureUiBuildSource = `const fs=require("node:fs");fs.mkdirSync("dist/control-ui",{recursive:true});fs.writeFileSync("dist/control-ui/index.html",${JSON.stringify(controlUiHtml)})`;
  const fixtureBuildPath = path.join(root, ".openclaw-fixture", "build.mjs");
  fs.mkdirSync(path.dirname(fixtureBuildPath), { recursive: true });
  fs.copyFileSync(new URL("./build.mjs", import.meta.url), fixtureBuildPath);
  // The tarball omits source .gitignore rules; build metadata must remain generated.
  fs.appendFileSync(
    path.join(root, ".gitignore"),
    "\n/dist/build-info.json\n/dist/.buildstamp\n/dist/.runtime-postbuildstamp\n",
  );
  packageJson.scripts = {
    ...packageJson.scripts,
    build: "node .openclaw-fixture/build.mjs",
    lint: 'node -e "console.log(\\"fixture lint skipped\\")"',
    "ui:build": `node -e ${JSON.stringify(fixtureUiBuildSource)}`,
  };
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
  writeControlUi(root);
}

function assertUpdate(channel) {
  const payload = JSON.parse(process.env.UPDATE_JSON ?? "");
  if (payload.status !== "ok") {
    throw new Error(`expected ${channel} update status ok, got ${payload.status}`);
  }
  if (channel === "dev" && payload.mode !== "git") {
    throw new Error(`expected dev update mode git, got ${payload.mode}`);
  }
  if (["stable", "beta"].includes(channel) && !["npm", "pnpm", "bun"].includes(payload.mode)) {
    throw new Error(`expected package-manager mode after ${channel} switch, got ${payload.mode}`);
  }
  if (payload.postUpdate?.plugins && payload.postUpdate.plugins.status !== "ok") {
    throw new Error(
      `expected plugin post-update ok, got ${JSON.stringify(payload.postUpdate?.plugins)}`,
    );
  }
}

function assertConfigChannel(channel) {
  const config = readJson(path.join(process.env.HOME, ".openclaw", "openclaw.json"));
  if (config.update?.channel === channel) {
    return;
  }
  if (process.env.OPENCLAW_PACKAGE_ACCEPTANCE_LEGACY_COMPAT === "1") {
    console.log(
      `legacy package did not persist update.channel ${channel}; got ${JSON.stringify(config.update?.channel)}`,
    );
    return;
  }
  throw new Error(
    `expected persisted update.channel ${channel}, got ${JSON.stringify(config.update?.channel)}`,
  );
}

function assertDryRun(kind, channel) {
  const preview = JSON.parse(process.env.UPDATE_JSON ?? "");
  assert.equal(preview.dryRun, true);
  assert.equal(preview.installKind, "package");
  assert.equal(preview.storedChannel, "dev");
  assert.equal(preview.effectiveChannel, channel);
  assert.equal(preview.updateInstallKind, kind);
  assert.equal(preview.mode, kind === "git" ? "git" : "npm");
  assert.equal(preview.switchToGit, kind === "git");
  assert.equal(preview.switchToPackage, false);
}

function assertStatusKind(kind) {
  const payload = JSON.parse(process.env.STATUS_JSON ?? "");
  if (payload.update?.installKind !== kind) {
    throw new Error(`expected ${kind} install after switch, got ${payload.update?.installKind}`);
  }
}

function assertInstalledVersion(root, expectedVersion) {
  const manifest = readJson(path.join(root, "package.json"));
  if (manifest.version !== expectedVersion) {
    throw new Error(
      `expected installed openclaw ${expectedVersion}, got ${String(manifest.version)}`,
    );
  }
}

switch (command) {
  case "prepare-git-fixture":
    prepareGitFixture(args[0] ?? "/tmp/openclaw-git");
    break;
  case "write-control-ui":
    writeControlUi(args[0] ?? "/tmp/openclaw-git");
    break;
  case "assert-update":
    assertUpdate(args[0]);
    break;
  case "assert-config-channel":
    assertConfigChannel(args[0]);
    break;
  case "assert-dry-run":
    assertDryRun(args[0], args[1]);
    break;
  case "assert-status-kind":
    assertStatusKind(args[0]);
    break;
  case "assert-installed-version":
    assertInstalledVersion(args[0], args[1]);
    break;
  default:
    usage();
}
