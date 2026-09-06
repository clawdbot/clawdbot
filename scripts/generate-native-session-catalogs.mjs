#!/usr/bin/env node
// Projects native catalog declarations into fresh-config defaults and the macOS resource.
import fs from "node:fs";
import path from "node:path";

const check = process.argv.includes("--check");
const root = process.cwd();
const catalogs = [];
const localOwners = new Set();
for (const dir of fs.readdirSync(path.join(root, "extensions")).toSorted()) {
  const file = path.join(root, "extensions", dir, "openclaw.plugin.json");
  if (!fs.existsSync(file)) {
    continue;
  }
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  if (manifest.id) {
    localOwners.add(manifest.id);
  }
  const catalog = manifest.setup?.nativeSessionCatalog;
  if (!catalog) {
    continue;
  }
  if (!manifest.id || !catalog.label?.trim()) {
    throw new Error(`Invalid native catalog declaration in ${file}`);
  }
  catalogs.push({ pluginId: manifest.id, ...catalog });
}
catalogs.sort((a, b) => a.pluginId.localeCompare(b.pluginId, "en"));
const byId = new Map(catalogs.map(({ pluginId, ...catalog }) => [pluginId, catalog]));
const outputs = new Map();
for (const name of ["plugin", "provider", "channel"]) {
  const file = `scripts/lib/official-external-${name}-catalog.json`;
  const original = fs.readFileSync(path.join(root, file), "utf8");
  const feed = JSON.parse(original);
  let changed = false;
  for (const entry of feed.entries) {
    const pluginId = entry.openclaw?.plugin?.id;
    if (!localOwners.has(pluginId)) {
      continue;
    }
    const catalog = byId.get(pluginId);
    const previous = entry.openclaw.setup?.nativeSessionCatalog;
    if (JSON.stringify(previous) === JSON.stringify(catalog)) {
      continue;
    }
    if (catalog) {
      entry.openclaw.setup = { ...entry.openclaw.setup, nativeSessionCatalog: catalog };
    } else {
      const setup = { ...entry.openclaw.setup };
      delete setup.nativeSessionCatalog;
      if (Object.keys(setup).length > 0) {
        entry.openclaw.setup = setup;
      } else {
        delete entry.openclaw.setup;
      }
    }
    changed = true;
  }
  outputs.set(file, changed ? `${JSON.stringify(feed, null, 2)}\n` : original);
}
const rendered = `${JSON.stringify(catalogs, null, 2)}\n`;
outputs.set("scripts/lib/native-session-catalogs.json", rendered);
outputs.set("apps/macos/Sources/OpenClaw/Resources/NativeSessionCatalogs.json", rendered);
for (const [relative, text] of outputs) {
  const file = path.join(root, relative);
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
  if (current === text) {
    continue;
  }
  if (check) {
    console.error(`${relative} is stale; run pnpm native-catalogs:gen`);
    process.exitCode = 1;
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}
