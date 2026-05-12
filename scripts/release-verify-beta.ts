#!/usr/bin/env -S node --import tsx

import { parseReleaseVerifyBetaArgs, verifyBetaRelease } from "./lib/release-beta-verifier.ts";

async function main() {
  const args = parseReleaseVerifyBetaArgs(process.argv.slice(2));
  const lines = await verifyBetaRelease(args);
  for (const line of lines) {
    console.log(line);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
