import fs from "node:fs";

const snapshotPath = process.argv[2] ?? "/tmp/browser-cdp-snapshot.txt";
const snapshot = fs.readFileSync(snapshotPath, "utf8");

for (const needle of [
  'button "Save"',
  'link "Docs"',
  "https://docs.openclaw.ai/browser-cdp-live",
  'generic "Clickable Card"',
  "cursor:pointer",
  'Iframe "Child"',
  'button "Inside"',
]) {
  if (!snapshot.includes(needle)) {
    console.error(snapshot);
    throw new Error(`missing snapshot needle: ${needle}`);
  }
}

console.log("ok");
