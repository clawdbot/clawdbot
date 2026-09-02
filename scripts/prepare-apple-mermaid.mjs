#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createPnpmRunnerSpawnSpec } from "./pnpm-runner.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const spec = createPnpmRunnerSpawnSpec({
  cwd: root,
  pnpmArgs: ["--filter", "@openclaw/mermaid-renderer", "build"],
  stdio: "inherit",
});
const result = spawnSync(spec.command, spec.args, spec.options);
if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const source = new URL("../apps/shared/mermaid/assets/mermaid/", import.meta.url);
const resources = new URL(
  "../apps/shared/OpenClawKit/Sources/OpenClawChatUI/Resources/",
  import.meta.url,
);
const destination = new URL("Mermaid/", resources);
await mkdir(resources, { recursive: true });
// SwiftPM needs the complete resource directory before project generation.
// Replace generated assets together so old content-addressed scripts cannot linger.
await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true });
