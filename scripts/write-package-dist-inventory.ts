#!/usr/bin/env -S node --import tsx
// Write Package Dist Inventory script supports OpenClaw repository automation.

import { pathToFileURL } from "node:url";
import { writePackageDistInventoryForPublish } from "./lib/package-dist-inventory.ts";

async function writeCurrentPackageDistInventory(): Promise<void> {
  await writePackageDistInventoryForPublish(process.cwd());
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await writeCurrentPackageDistInventory();
}
