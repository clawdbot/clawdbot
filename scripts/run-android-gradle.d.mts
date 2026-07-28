#!/usr/bin/env node
export function splitAndroidGradleArgs(argv: unknown): {
  gradleArgs: unknown;
  postArgs: unknown;
};
export function shouldSkipLinuxArmAndroidGradle(options?: Record<string, unknown>): boolean;
export function linuxArmAndroidGradleSkipMessage(
  platform?: NodeJS.Platform,
  arch?: NodeJS.Architecture,
): string;
export function resolveAndroidSdkEnv(options?: {
  env?: NodeJS.ProcessEnv;
  existsSync?: (path: string) => boolean;
  homeDir?: string;
  platform?: NodeJS.Platform;
}): NodeJS.ProcessEnv;
export function run(
  command: unknown,
  args: unknown,
  cwd: unknown,
  env?: NodeJS.ProcessEnv,
): Promise<unknown>;
export function main(argv?: string[]): Promise<unknown>;
