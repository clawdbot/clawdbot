#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runManagedCommand } from "./lib/managed-child-process.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";

const repoRoot = resolveRepoRoot(import.meta.url);
const androidDir = path.join(repoRoot, "apps", "android");
const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

type RuntimeOptions = Partial<Pick<NodeJS.Process, "arch" | "env" | "platform">>;
type SdkOptions = Omit<RuntimeOptions, "arch"> & {
  existsSync?: (path: string) => boolean;
  homeDir?: string;
};

export function splitAndroidGradleArgs(argv: string[]) {
  const separator = argv.indexOf("--");
  if (separator === -1) {
    return { gradleArgs: argv, postArgs: [] };
  }
  return {
    gradleArgs: argv.slice(0, separator),
    postArgs: argv.slice(separator + 1),
  };
}

export function shouldSkipLinuxArmAndroidGradle(options: RuntimeOptions = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  if (env.OPENCLAW_ANDROID_GRADLE_ALLOW_LINUX_ARM === "1") {
    return false;
  }
  return platform === "linux" && (arch === "arm64" || arch === "arm");
}

export function linuxArmAndroidGradleSkipMessage(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
) {
  return (
    `[android-gradle] skipped on ${platform}/${arch}: ` +
    "Android Gradle resource tasks require the Linux x86_64 AAPT2 artifact. " +
    "Run this task on x64 Linux/macOS or set OPENCLAW_ANDROID_GRADLE_ALLOW_LINUX_ARM=1 to try anyway."
  );
}

// Fresh git worktrees do not carry the gitignored apps/android/local.properties,
// so AGP tasks fail with "SDK location not found" even when an SDK is installed.
// Fall back to the Android Studio default install path when nothing names one.
export function resolveAndroidSdkEnv(options: SdkOptions = {}) {
  const env = options.env ?? process.env;
  if (env.ANDROID_HOME || env.ANDROID_SDK_ROOT) {
    return env;
  }
  const existsSync = options.existsSync ?? fs.existsSync;
  if (existsSync(path.join(androidDir, "local.properties"))) {
    return env;
  }
  const homeDir = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const defaultSdkDir =
    platform === "darwin"
      ? path.join(homeDir, "Library", "Android", "sdk")
      : path.join(homeDir, "Android", "Sdk");
  if (!existsSync(defaultSdkDir)) {
    return env;
  }
  return { ...env, ANDROID_HOME: defaultSdkDir };
}

export async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  try {
    return await runManagedCommand({
      args: [...args],
      bin: command,
      cwd,
      env,
      shell: false,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function main(argv: string[] = process.argv.slice(2)) {
  const { gradleArgs, postArgs } = splitAndroidGradleArgs(argv);
  if (gradleArgs.length === 0) {
    console.error(
      "Usage: node --import tsx scripts/run-android-gradle.mts <gradle-task...> [-- <post-command...>]",
    );
    return 1;
  }

  if (shouldSkipLinuxArmAndroidGradle()) {
    // Google's Linux AAPT2 artifact is x86_64-only, so resource tasks fail on
    // Linux arm64 before app code or tests run. CI Android lanes use x64 runners.
    console.log(linuxArmAndroidGradleSkipMessage());
    return 0;
  }

  const env = resolveAndroidSdkEnv();
  const gradleStatus = await run("./gradlew", gradleArgs, androidDir, env);
  const command = postArgs[0];
  if (gradleStatus !== 0 || command === undefined) {
    return gradleStatus;
  }

  return await run(command, postArgs.slice(1), repoRoot, env);
}

if (isMain) {
  process.exit(await main());
}
