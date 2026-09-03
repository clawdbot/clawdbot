#!/usr/bin/env node
import { runNodeCliShim } from "./lib/tsx-cli-shim.mjs";

await runNodeCliShim(import.meta.url, { implementation: "./watch-pr-ci.mts" });
