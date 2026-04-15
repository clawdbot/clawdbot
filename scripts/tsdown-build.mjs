#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BUNDLED_PLUGIN_PATH_PREFIX } from "./lib/bundled-plugin-paths.mjs";
import { resolvePnpmRunner } from "./pnpm-runner.mjs";
import {
  isSourceCheckoutRoot,
  pruneBundledPluginSourceNodeModules,
} from "./postinstall-bundled-plugins.mjs";

const logLevel = process.env.OPENCLAW_BUILD_VERBOSE ? "info" : "warn";
const extraArgs = process.argv.slice(2);
const INEFFECTIVE_DYNAMIC_IMPORT_RE = /\[INEFFECTIVE_DYNAMIC_IMPORT\]/;
const UNRESOLVED_IMPORT_RE = /\[UNRESOLVED_IMPORT\]/;
const ANSI_ESCAPE_RE = new RegExp(String.raw`\u001B\[[0-9;]*m`, "g");
const HASHED_ROOT_JS_RE = /^(?<base>.+)-[A-Za-z0-9_-]+\.js$/u;

function removeDistPluginNodeModulesSymlinks(rootDir) {
  const extensionsDir = path.join(rootDir, "extensions");
  if (!fs.existsSync(extensionsDir)) {
    return;
  }

  for (const dirent of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const nodeModulesPath = path.join(extensionsDir, dirent.name, "node_modules");
    try {
      if (fs.lstatSync(nodeModulesPath).isSymbolicLink()) {
        fs.rmSync(nodeModulesPath, { force: true, recursive: true });
      }
    } catch {
      // Skip missing or unreadable paths so the build can proceed.
    }
  }
}

function pruneStaleRuntimeSymlinks() {
  const cwd = process.cwd();
  // runtime-postbuild stages plugin-owned node_modules into dist/ and links the
  // dist-runtime overlay back to that tree. Remove only those symlinks up front
  // so tsdown's clean step cannot traverse stale runtime overlays on rebuilds.
  removeDistPluginNodeModulesSymlinks(path.join(cwd, "dist"));
  removeDistPluginNodeModulesSymlinks(path.join(cwd, "dist-runtime"));
}

export function pruneStaleRootChunkFiles(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const roots = [path.join(cwd, "dist"), path.join(cwd, "dist-runtime")];
  for (const root of roots) {
    let entries = [];
    try {
      entries = fsImpl.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (!HASHED_ROOT_JS_RE.test(entry.name)) {
        continue;
      }
      try {
        fsImpl.rmSync(path.join(root, entry.name), { force: true });
      } catch {
        // Best-effort cleanup. The subsequent build will overwrite any stragglers.
      }
    }
  }
}

export function pruneSourceCheckoutBundledPluginNodeModules(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const logger = params.logger ?? console;
  if (!isSourceCheckoutRoot({ packageRoot: cwd, existsSync: fs.existsSync })) {
    return;
  }
  try {
    pruneBundledPluginSourceNodeModules({
      extensionsDir: path.join(cwd, "extensions"),
      existsSync: fs.existsSync,
      readdirSync: fs.readdirSync,
      rmSync: fs.rmSync,
    });
  } catch (error) {
    logger.warn(`tsdown: could not prune bundled plugin source node_modules: ${String(error)}`);
  }
}

function findFatalUnresolvedImport(lines) {
  for (const line of lines) {
    if (!UNRESOLVED_IMPORT_RE.test(line)) {
      continue;
    }

    const normalizedLine = line.replace(ANSI_ESCAPE_RE, "");
    if (
      !normalizedLine.includes(BUNDLED_PLUGIN_PATH_PREFIX) &&
      !normalizedLine.includes("node_modules/")
    ) {
      return normalizedLine;
    }
  }

  return null;
}

export function resolveTsdownBuildInvocation(params = {}) {
  const env = params.env ?? process.env;
  const runner = resolvePnpmRunner({
    pnpmArgs: ["exec", "tsdown", "--config-loader", "unrun", "--logLevel", logLevel, ...extraArgs],
    nodeExecPath: params.nodeExecPath ?? process.execPath,
    npmExecPath: params.npmExecPath ?? env.npm_execpath,
    comSpec: params.comSpec ?? env.ComSpec,
    platform: params.platform ?? process.platform,
  });
  return {
    command: runner.command,
    args: runner.args,
    options: {
      encoding: "utf8",
      stdio: "pipe",
      shell: runner.shell,
      windowsVerbatimArguments: runner.windowsVerbatimArguments,
      env,
    },
  };
}

function isMainModule() {
  const argv1 = process.argv[1];
  if (!argv1) {
    return false;
  }
  return import.meta.url === pathToFileURL(argv1).href;
}

if (isMainModule()) {
  pruneSourceCheckoutBundledPluginNodeModules();
  pruneStaleRuntimeSymlinks();
  pruneStaleRootChunkFiles();
  const invocation = resolveTsdownBuildInvocation();
  const result = spawnSync(invocation.command, invocation.args, invocation.options);

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (stdout) {
    process.stdout.write(stdout);
  }
  if (stderr) {
    process.stderr.write(stderr);
  }

  if (result.status === 0 && INEFFECTIVE_DYNAMIC_IMPORT_RE.test(`${stdout}\n${stderr}`)) {
    console.error(
      "Build emitted [INEFFECTIVE_DYNAMIC_IMPORT]. Replace transparent runtime re-export facades with real runtime boundaries.",
    );
    process.exit(1);
  }

  const fatalUnresolvedImport =
    result.status === 0 ? findFatalUnresolvedImport(`${stdout}\n${stderr}`.split("\n")) : null;

  if (fatalUnresolvedImport) {
    console.error(`Build emitted [UNRESOLVED_IMPORT] outside extensions: ${fatalUnresolvedImport}`);
    process.exit(1);
  }

  if (typeof result.status === "number") {
    process.exit(result.status);
  }

  process.exit(1);
}
