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

function optionValue(name, envName, fallback) {
  const index = args.indexOf(name);
  if (index !== -1) {
    return {
      label: name,
      value: option(name),
    };
  }
  return {
    label: envName,
    value: process.env[envName] ?? fallback,
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readStrictInteger({ allowZero = false, label, value }) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`invalid ${label}: ${text}`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new Error(`invalid ${label}: ${text}`);
  }
  return parsed;
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
const timeoutOption = optionValue(
  "--timeout-ms",
  "OPENCLAW_UPGRADE_SURVIVOR_PROBE_TIMEOUT_MS",
  "60000",
);
const attemptTimeoutOption = optionValue(
  "--attempt-timeout-ms",
  "OPENCLAW_UPGRADE_SURVIVOR_PROBE_ATTEMPT_TIMEOUT_MS",
  "5000",
);
const maxBodyOption = optionValue(
  "--max-body-bytes",
  "OPENCLAW_UPGRADE_SURVIVOR_PROBE_MAX_BODY_BYTES",
  "1048576",
);
const timeoutMs = readStrictInteger({ ...timeoutOption, allowZero: true });
const attemptTimeoutMs = readStrictInteger(attemptTimeoutOption);
const maxBodyBytes = readStrictInteger(maxBodyOption);
const url = new URL(probePath, baseUrl).toString();
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

async function readBoundedResponseText(response, byteLimit) {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const chunks = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    totalBytes += value.byteLength;
    if (totalBytes > byteLimit) {
      await reader.cancel();
      throw new Error(`${url} probe body exceeded ${byteLimit} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

async function fetchProbeText() {
  const elapsedMs = Date.now() - startedAt;
  const remainingMs = Math.max(1, timeoutMs - elapsedMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(attemptTimeoutMs, remainingMs));
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    return {
      response,
      text: await readBoundedResponseText(response, maxBodyBytes),
    };
  } finally {
    clearTimeout(timer);
  }
}

const startedAt = Date.now();
let lastError;
let lastResult;

while (Date.now() - startedAt <= timeoutMs) {
  try {
    const { response, text } = await fetchProbeText();
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
  await new Promise((resolve) => {
    setTimeout(resolve, 500);
  });
}

const suffix = lastResult ? ` (last HTTP ${lastResult.status}: ${lastResult.text})` : "";
throw new Error(
  `${url} probe did not satisfy ${expectKind} within ${timeoutMs}ms: ${lastError ?? "no response"}${suffix}`,
);
