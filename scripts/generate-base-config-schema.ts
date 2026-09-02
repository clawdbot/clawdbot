#!/usr/bin/env node
// Generate Base Config Schema script supports OpenClaw repository automation.
import { pathToFileURL } from "node:url";
import { computeBaseConfigSchemaResponse } from "../src/config/schema-base.js";

function checkBaseConfigSchema(): void {
  computeBaseConfigSchemaResponse({
    generatedAt: "2026-05-05T00:00:00.000Z",
  });
}

const args = new Set(process.argv.slice(2));
if (args.has("--check") && args.has("--write")) {
  throw new Error("Use either --check or --write, not both.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  checkBaseConfigSchema();
  if (args.has("--write")) {
    console.log("[base-config-schema] runtime-computed; no generated file to write");
  } else {
    console.log("[base-config-schema] ok");
  }
}
