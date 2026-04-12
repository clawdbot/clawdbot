#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { NPM_UPDATE_COMPAT_SIDECARS } from "./lib/npm-update-compat-sidecars.mjs";

for (const entry of NPM_UPDATE_COMPAT_SIDECARS) {
  fs.mkdirSync(path.dirname(entry.path), { recursive: true });
  fs.writeFileSync(entry.path, entry.content, "utf8");
}
