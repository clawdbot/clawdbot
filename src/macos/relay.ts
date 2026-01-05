#!/usr/bin/env node
import process from "node:process";

declare const __CLAWDBOT_VERSION__: string | undefined;

const BUNDLED_VERSION =
  typeof __CLAWDBOT_VERSION__ === "string" ? __CLAWDBOT_VERSION__ : "0.0.0";

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

async function patchBunLongForProtobuf(): Promise<void> {
  // Bun ships a global `Long` that protobufjs detects, but it is not long.js and
  // misses critical APIs (fromBits, ...). Baileys WAProto expects long.js.
  if (typeof process.versions.bun !== "string") return;
  const mod = await import("long");
  const Long = (mod as unknown as { default?: unknown }).default ?? mod;
  (globalThis as unknown as { Long?: unknown }).Long = Long;
}

async function main() {
  const args = process.argv.slice(2);

  // Swift side expects `--version` to return a plain semver string.
  if (
    hasFlag(args, "--version") ||
    hasFlag(args, "-V") ||
    hasFlag(args, "-v")
  ) {
    console.log(BUNDLED_VERSION);
    process.exit(0);
  }

  await patchBunLongForProtobuf();

  const { loadDotEnv } = await import("../infra/dotenv.js");
  loadDotEnv({ quiet: true });

  const { ensureClawdbotCliOnPath } = await import("../infra/path-env.js");
  ensureClawdbotCliOnPath();

  const { enableConsoleCapture } = await import("../logging.js");
  enableConsoleCapture();

  const { assertSupportedRuntime } = await import("../infra/runtime-guard.js");
  assertSupportedRuntime();
  const { isUnhandledRejectionHandled } = await import(
    "../infra/unhandled-rejections.js"
  );

  const { buildProgram } = await import("../cli/program.js");
  const program = buildProgram();

  process.on("unhandledRejection", (reason, _promise) => {
    if (isUnhandledRejectionHandled(reason)) return;
    console.error(
      "[clawdbot] Unhandled promise rejection:",
      reason instanceof Error ? (reason.stack ?? reason.message) : reason,
    );
    process.exit(1);
  });

  process.on("uncaughtException", (error) => {
    console.error(
      "[clawdbot] Uncaught exception:",
      error.stack ?? error.message,
    );
    process.exit(1);
  });

  await program.parseAsync(process.argv);
}

void main();
