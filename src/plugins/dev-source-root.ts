// Resolves development source roots for local plugin installs.
import fs from "node:fs";
import path from "node:path";
import { resolveUserPath } from "../utils.js";
import { isPathInside, safeRealpathSync } from "./path-safety.js";

/** Env var that points bundled-plugin lookup at an OpenClaw source checkout. */
export const OPENCLAW_DEV_SOURCE_ROOT_ENV = "OPENCLAW_DEV_SOURCE_ROOT";

function readPackageName(packageJsonPath: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : null;
  } catch {
    return null;
  }
}

/** Resolves and validates the configured OpenClaw development source root. */
export function resolveOpenClawDevSourceRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const rawRoot = env[OPENCLAW_DEV_SOURCE_ROOT_ENV]?.trim();
  if (!rawRoot) {
    return null;
  }
  const resolvedRoot = resolveUserPath(rawRoot, env);
  const realRoot = safeRealpathSync(resolvedRoot);
  if (!realRoot) {
    return null;
  }
  if (readPackageName(path.join(realRoot, "package.json")) !== "openclaw") {
    return null;
  }
  if (!fs.existsSync(path.join(realRoot, "src"))) {
    return null;
  }
  if (!fs.existsSync(path.join(realRoot, "extensions"))) {
    return null;
  }
  return realRoot;
}

/** True when a bundled plugin root is inside the configured development source root. */
export function isBundledPluginInsideDevSourceRoot(params: {
  rootDir: string;
  env: NodeJS.ProcessEnv;
}): boolean {
  const devSourceRoot = resolveOpenClawDevSourceRoot(params.env);
  if (!devSourceRoot) {
    return false;
  }
  const extensionsRoot = safeRealpathSync(path.join(devSourceRoot, "extensions"));
  const pluginRoot = safeRealpathSync(resolveUserPath(params.rootDir, params.env));
  if (!extensionsRoot || !pluginRoot) {
    return false;
  }
  return isPathInside(extensionsRoot, pluginRoot);
}
