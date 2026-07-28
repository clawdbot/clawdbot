#!/usr/bin/env node
/**
 * Parses extension memory profiler options after pnpm's optional separator.
 */
export function parseArgs(argv: string[]): {
  extensions: string[];
  concurrency: number;
  timeoutMs: number;
  combinedTimeoutMs: number;
  top: number;
  jsonPath: string | null;
  skipCombined: boolean;
};
/**
 * Runs one import scenario in a child process and captures bounded output plus RSS.
 */
export function runCase({
  repoRoot,
  env,
  hookPath,
  name,
  body,
  timeoutMs,
  shutdownGraceMs,
  spawnImpl,
}: {
  repoRoot: unknown;
  env: unknown;
  hookPath: unknown;
  name: unknown;
  body: unknown;
  timeoutMs: unknown;
  shutdownGraceMs?: number | undefined;
  spawnImpl?: typeof spawn | undefined;
}): Promise<unknown>;
import { spawn } from "node:child_process";
