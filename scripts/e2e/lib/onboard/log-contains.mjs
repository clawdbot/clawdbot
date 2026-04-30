import fs from "node:fs";

const [file, needle] = process.argv.slice(2);
if (!file || !needle) {
  process.exit(1);
}

let text = "";
try {
  text = fs.readFileSync(file, "utf8");
} catch {
  process.exit(1);
}

if (text.length > 120000) {
  text = text.slice(-120000);
}

const normalizeScriptOutput = (value) => value.replace(/\r?\n/g, "").replace(/\r/g, "");
const oscPattern = new RegExp(String.raw`\u001b\][^\u0007]*(?:\u0007|\u001b\\)`, "g");
const csiPattern = new RegExp(String.raw`\u001b\[[0-?]*[ -/]*[@-~]`, "g");

const stripAnsi = (value) =>
  normalizeScriptOutput(value).replace(oscPattern, "").replace(csiPattern, "");

const compact = (value) =>
  stripAnsi(value)
    .toLowerCase()
    .replace(/[^a-z]+/g, "");
const compactNeedle = compact(needle);

process.exit(compactNeedle && compact(text).includes(compactNeedle) ? 0 : 1);
