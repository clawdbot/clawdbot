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
const allowFailing = new Set(
  option("--allow-failing", "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean),
);
const timeoutMs = Number.parseInt(
  option("--timeout-ms", process.env.OPENCLAW_UPGRADE_SURVIVOR_PROBE_TIMEOUT_MS || "60000"),
  10,
);
const url = new URL(probePath, baseUrl).toString();

if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
  throw new Error(`invalid --timeout-ms: ${String(timeoutMs)}`);
}
if (expectKind !== "live" && expectKind !== "ready") {
  throw new Error(`unknown probe expectation: ${expectKind}`);
}

function matchesExpectation(body) {
  if (expectKind === "live") {
    return body?.ok === true && body?.status === "live";
  }
  if (body?.ready === true) {
    return true;
  }
  const failing = Array.isArray(body?.failing) ? body.failing : [];
  return (
    failing.length > 0 &&
    allowFailing.size > 0 &&
    failing.every((entry) => allowFailing.has(String(entry)))
  );
}

const startedAt = Date.now();
let lastError;
let lastResult;

while (Date.now() - startedAt <= timeoutMs) {
  try {
    const response = await fetch(url, { method: "GET" });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch (error) {
      throw new Error(`${url} returned non-JSON probe body: ${String(error)}`, { cause: error });
    }
    lastResult = {
      body,
      status: response.status,
      text,
    };
    const expectationMet = matchesExpectation(body);
    if ((response.ok || expectKind === "ready") && expectationMet) {
      writeJson(out, {
        body,
        elapsedMs: Date.now() - startedAt,
        path: probePath,
        status: response.status,
        url,
      });
      process.exit(0);
    }
    lastError = response.ok
      ? `${url} did not report ${expectKind} status: ${text}`
      : `${url} probe failed with HTTP ${response.status}: ${text}`;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

const suffix = lastResult ? ` (last HTTP ${lastResult.status}: ${lastResult.text})` : "";
throw new Error(
  `${url} probe did not satisfy ${expectKind} within ${timeoutMs}ms: ${lastError ?? "no response"}${suffix}`,
);
