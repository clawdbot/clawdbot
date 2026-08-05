#!/usr/bin/env node

if (process.argv[2] !== "acp" || process.argv[3] !== "native") {
  process.argv.splice(2, 0, "acp", "native");
}
await import("./openclaw.mjs");
