import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";

const PRIVATE_QA_DIST_RELATIVE_PATH = path.join("dist", "plugin-sdk", "qa-lab.js");

export function isPrivateQaCliEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENCLAW_ENABLE_PRIVATE_QA_CLI === "1";
}

function resolvePrivateQaSourceModuleSpecifier(params?: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  argv1?: string;
  moduleUrl?: string;
  resolvePackageRootSync?: typeof resolveOpenClawPackageRootSync;
  existsSync?: typeof fs.existsSync;
}): string | null {
  const env = params?.env ?? process.env;
  if (!isPrivateQaCliEnabled(env)) {
    return null;
  }
  const resolvePackageRootSync = params?.resolvePackageRootSync ?? resolveOpenClawPackageRootSync;
  const packageRoot = resolvePackageRootSync({
    argv1: params?.argv1 ?? process.argv[1],
    cwd: params?.cwd ?? process.cwd(),
    moduleUrl: params?.moduleUrl ?? import.meta.url,
  });
  if (!packageRoot) {
    return null;
  }
  const existsSync = params?.existsSync ?? fs.existsSync;
  const sourceModulePath = path.join(packageRoot, PRIVATE_QA_DIST_RELATIVE_PATH);
  if (
    !existsSync(path.join(packageRoot, ".git")) ||
    !existsSync(path.join(packageRoot, "src")) ||
    !existsSync(sourceModulePath)
  ) {
    return null;
  }
  return pathToFileURL(sourceModulePath).href;
}

async function dynamicImportPrivateQaCliModule(
  specifier: string,
): Promise<Record<string, unknown>> {
  return (await import(specifier)) as Record<string, unknown>;
}

export function loadPrivateQaCliModule(params?: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  argv1?: string;
  moduleUrl?: string;
  resolvePackageRootSync?: typeof resolveOpenClawPackageRootSync;
  existsSync?: typeof fs.existsSync;
  importModule?: (specifier: string) => Promise<Record<string, unknown>>;
}): Promise<Record<string, unknown>> {
  const specifier = resolvePrivateQaSourceModuleSpecifier(params);
  if (!specifier) {
    throw new Error("Private QA CLI is only available from an OpenClaw source checkout.");
  }
  return (params?.importModule ?? dynamicImportPrivateQaCliModule)(specifier);
}
