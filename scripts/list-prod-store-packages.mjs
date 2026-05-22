import fs from "node:fs";

const parsed = JSON.parse(fs.readFileSync(0, "utf8"));
const roots = Array.isArray(parsed) ? parsed : [parsed];
const specs = new Set();

function visit(node) {
  for (const dep of Object.values(node.dependencies ?? {})) {
    const name = dep.from || dep.name;
    if (name && dep.version && dep.resolved?.startsWith("https://registry.npmjs.org/")) {
      specs.add(`${name}@${dep.version}`);
    }
    visit(dep);
  }
}

for (const root of roots) {
  visit(root);
}

process.stdout.write([...specs].toSorted((a, b) => a.localeCompare(b)).join("\n"));
