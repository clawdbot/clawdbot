#!/usr/bin/env -S node --import tsx

import { pathToFileURL } from "node:url";
import { writePackageDistInventory } from "../src/infra/package-dist-inventory.ts";

export async function writeCurrentPackageDistInventory(): Promise<void> {
  await writePackageDistInventory(process.cwd());
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await writeCurrentPackageDistInventory();
}
