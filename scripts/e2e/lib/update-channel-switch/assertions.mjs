import fs from "node:fs";
import path from "node:path";
import { legacyPackageAcceptanceCompat } from "../package-compat.mjs";

const [command, ...args] = process.argv.slice(2);
const controlUiHtml = "<!doctype html><title>fixture</title>\n";

function usage() {
  console.error(
    "usage: assertions.mjs <prepare-git-fixture|write-control-ui|assert-update|assert-config-channel|assert-status-kind> [...]",
  );
  process.exit(2);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeControlUi(root) {
  const file = path.join(root, "dist", "control-ui", "index.html");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, controlUiHtml);
}

function prepareGitFixture(root) {
  const packageJsonPath = path.join(root, "package.json");
  const packageJson = readJson(packageJsonPath);
  packageJson.pnpm = { ...packageJson.pnpm, allowUnusedPatches: true };
  const patches = packageJson.pnpm.patchedDependencies;
  if (patches && typeof patches === "object" && !Array.isArray(patches)) {
    const kept = {};
    const missing = [];
    for (const [dependency, patchFile] of Object.entries(patches)) {
      const exists =
        typeof patchFile === "string" &&
        fs.existsSync(path.resolve(path.dirname(packageJsonPath), patchFile));
      if (exists) {
        kept[dependency] = patchFile;
      } else {
        missing.push(`${dependency} -> ${String(patchFile)}`);
      }
    }
    if (missing.length > 0 && !legacyPackageAcceptanceCompat(packageJson.version)) {
      throw new Error(
        `package ${packageJson.version} has missing pnpm.patchedDependencies in package fixture: ${missing.join(", ")}`,
      );
    }
    if (Object.keys(kept).length > 0) {
      packageJson.pnpm.patchedDependencies = kept;
    } else {
      delete packageJson.pnpm.patchedDependencies;
    }
  }
  const fixtureUiBuildSource = `const fs=require("node:fs");fs.mkdirSync("dist/control-ui",{recursive:true});fs.writeFileSync("dist/control-ui/index.html",${JSON.stringify(controlUiHtml)})`;
  packageJson.scripts = {
    ...packageJson.scripts,
    build: 'node -e "console.log(\\"fixture build skipped\\")"',
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
  if (channel === "stable" && !["npm", "pnpm", "bun"].includes(payload.mode)) {
    throw new Error(`expected package-manager mode after stable switch, got ${payload.mode}`);
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

function assertStatusKind(kind) {
  const payload = JSON.parse(process.env.STATUS_JSON ?? "");
  if (payload.update?.installKind !== kind) {
    throw new Error(`expected ${kind} install after switch, got ${payload.update?.installKind}`);
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
  case "assert-status-kind":
    assertStatusKind(args[0]);
    break;
  default:
    usage();
}
