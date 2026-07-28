#!/usr/bin/env node
/**
 * Release preflight helper that verifies required provider API keys without
 * printing secret values. Anthropic must complete a prompt because model-list
 * access does not prove billing or inference entitlement.
 */
import process from "node:process";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (!arg.startsWith("--")) {
    continue;
  }
  const [key, inlineValue] = arg.slice(2).split("=", 2);
  const value = inlineValue ?? process.argv[index + 1];
  if (inlineValue === undefined) {
    index += 1;
  }
  args.set(key, value);
}

const requiredInput = String(args.get("required") ?? "openai,anthropic").trim();
const required = new Set(
  (requiredInput.toLowerCase() === "none" ? "" : requiredInput)
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean),
);

const timeoutMs = Number(args.get("timeout-ms") ?? 10_000);

function envFirst(names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return { name, value };
    }
  }
  return undefined;
}

async function checkProvider(id, config) {
  const secret = envFirst(config.env);
  if (!secret) {
    return { id, ok: false, status: "missing", env: config.env.join("|") };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = config.headers(secret.value);
    const response = await fetch(config.url, {
      body: config.body,
      headers,
      method: config.method,
      signal: controller.signal,
    });
    const responseBody = config.validateResponse
      ? await response.json().catch(() => undefined)
      : undefined;
    const ok = response.ok && (!config.validateResponse || config.validateResponse(responseBody));
    return {
      id,
      ok,
      status: response.ok ? (ok ? "ok" : "invalid_response") : `http_${response.status}`,
      env: secret.name,
    };
  } catch (error) {
    return {
      id,
      ok: false,
      status: error?.name === "AbortError" ? "timeout" : "error",
      env: secret.name,
    };
  } finally {
    clearTimeout(timer);
  }
}

const providers = {
  openai: {
    env: ["OPENAI_API_KEY"],
    url: "https://api.openai.com/v1/models",
    headers: (token) => ({ authorization: `Bearer ${token}` }),
  },
  anthropic: {
    env: ["ANTHROPIC_API_KEY", "ANTHROPIC_API_TOKEN"],
    url: "https://api.anthropic.com/v1/messages",
    method: "POST",
    body: JSON.stringify({
      max_tokens: 8,
      messages: [{ role: "user", content: "Reply with OK." }],
      model: "claude-haiku-4-5",
    }),
    headers: (token) => ({
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": token,
    }),
    validateResponse: (body) =>
      Array.isArray(body?.content) &&
      body.content.some((part) => typeof part?.text === "string" && part.text.trim()),
  },
  fireworks: {
    env: ["FIREWORKS_API_KEY"],
    url: "https://api.fireworks.ai/inference/v1/models",
    headers: (token) => ({ authorization: `Bearer ${token}` }),
  },
  openrouter: {
    env: ["OPENROUTER_API_KEY"],
    url: "https://openrouter.ai/api/v1/models",
    headers: (token) => ({ authorization: `Bearer ${token}` }),
  },
};

const unknown = [...required].filter((id) => !providers[id]);
if (unknown.length > 0) {
  console.error(`unknown providers: ${unknown.join(",")}`);
  process.exit(2);
}

const results = [];
for (const id of Object.keys(providers)) {
  if (required.has(id) || envFirst(providers[id].env)) {
    results.push(await checkProvider(id, providers[id]));
  }
}

let failed = false;
for (const result of results) {
  const requiredLabel = required.has(result.id) ? "required" : "optional";
  console.log(`${result.id}: ${result.status} env=${result.env} ${requiredLabel}`);
  if (required.has(result.id) && !result.ok) {
    failed = true;
  }
}

if (failed) {
  console.error("release provider secret preflight failed");
  process.exit(1);
}
