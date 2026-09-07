#!/usr/bin/env -S node --import tsx
// Write Package Dist Inventory script supports OpenClaw repository automation.

import { fileURLToPath } from "node:url";
import { isMainModule } from "../src/infra/is-main.ts";
import { writePackageDistInventoryForPublish } from "./lib/package-dist-inventory.ts";

// Match argv only; PM2 hints must not turn an import into a package write.
if (isMainModule({ currentFile: fileURLToPath(import.meta.url), env: {} })) {
  await writePackageDistInventoryForPublish(process.cwd());
}
