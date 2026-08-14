// Bumps the trailing numeric segment of package.json "version" in place.
// 2026.7.2-beta.7 -> 2026.7.2-beta.8 ; 1.2.3 -> 1.2.4
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pkgPath = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

const parts = String(pkg.version ?? "0.0.0").split(".");
let bumped = false;
for (let i = parts.length - 1; i >= 0; i--) {
  if (/^\d+$/.test(parts[i])) {
    parts[i] = String(Number(parts[i]) + 1);
    bumped = true;
    break;
  }
}
if (!bumped) throw new Error("Cannot bump version: " + pkg.version);
const next = parts.join(".");
pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(next);
