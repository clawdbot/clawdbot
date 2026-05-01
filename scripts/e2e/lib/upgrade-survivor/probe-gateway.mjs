#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  const value = args[index + 1];
  if (!value) {
    throw new Error(`missing value for ${name}`);
  }
  return value;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

const baseUrl = option("--base-url");
const probePath = option("--path");
const expectKind = option("--expect");
const out = option("--out");
const url = new URL(probePath, baseUrl).toString();

const startedAt = Date.now();
const response = await fetch(url, { method: "GET" });
const text = await response.text();
let body;
try {
  body = text ? JSON.parse(text) : null;
} catch (error) {
  throw new Error(`${url} returned non-JSON probe body: ${String(error)}`, { cause: error });
}
const elapsedMs = Date.now() - startedAt;

if (!response.ok) {
  throw new Error(`${url} probe failed with HTTP ${response.status}: ${text}`);
}
if (expectKind === "live") {
  if (body?.ok !== true || body?.status !== "live") {
    throw new Error(`${url} did not report live status: ${text}`);
  }
} else if (expectKind === "ready") {
  if (body?.ready !== true) {
    throw new Error(`${url} did not report ready status: ${text}`);
  }
} else {
  throw new Error(`unknown probe expectation: ${expectKind}`);
}

writeJson(out, {
  body,
  elapsedMs,
  path: probePath,
  status: response.status,
  url,
});
