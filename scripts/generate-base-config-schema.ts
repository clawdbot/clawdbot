#!/usr/bin/env node
import { computeBaseConfigSchemaResponse } from "../src/config/schema-base.js";

export function checkBaseConfigSchema(): void {
  computeBaseConfigSchemaResponse({
    generatedAt: "2026-05-05T00:00:00.000Z",
  });
}

const args = new Set(process.argv.slice(2));
if (args.has("--check") && args.has("--write")) {
  throw new Error("Use either --check or --write, not both.");
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file://").href) {
  checkBaseConfigSchema();
  if (args.has("--write")) {
    console.log("[base-config-schema] runtime-computed; no generated file to write");
  } else {
    console.log("[base-config-schema] ok");
  }
}
