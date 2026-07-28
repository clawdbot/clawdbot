// Probe script for OpenWebUI E2E connectivity.
import { Agent, setGlobalDispatcher } from "undici";
import { escapeRegExp } from "../lib/regexp.mjs";
import { readBoundedResponseText as readBoundedResponseTextWithLimit } from "./lib/bounded-response-text.mjs";

const baseUrl = process.env.OPENWEBUI_BASE_URL ?? "";
const email = process.env.OPENWEBUI_ADMIN_EMAIL ?? "";
const password = process.env.OPENWEBUI_ADMIN_PASSWORD ?? "";
const expectedNonce = process.env.OPENWEBUI_EXPECTED_NONCE ?? "";
const prompt = process.env.OPENWEBUI_PROMPT ?? "";
const MAX_TIMER_TIMEOUT_MS = 2_147_000_000;
const modelAttempts = readPositiveInt("OPENWEBUI_MODEL_ATTEMPTS", 72);
const modelRetryMs = readNonNegativeTimerMs("OPENWEBUI_MODEL_RETRY_MS", 5000);
const fetchTimeoutMs = readPositiveTimerMs("OPENWEBUI_FETCH_TIMEOUT_MS", 720000);
const controlTimeoutMs = readPositiveTimerMs(
  "OPENWEBUI_CONTROL_TIMEOUT_MS",
  Math.min(fetchTimeoutMs, 30000),
);
const chatTimeoutMs = readPositiveTimerMs("OPENWEBUI_CHAT_TIMEOUT_MS", fetchTimeoutMs);
const responseBodyMaxBytes = readPositiveInt("OPENWEBUI_RESPONSE_BODY_MAX_BYTES", 1024 * 1024);
const smokeMode =
  process.env.OPENWEBUI_SMOKE_MODE ?? process.env.OPENCLAW_OPENWEBUI_SMOKE_MODE ?? "chat";

setGlobalDispatcher(
  new Agent({
    bodyTimeout: Math.max(controlTimeoutMs, chatTimeoutMs),
    headersTimeout: Math.max(controlTimeoutMs, chatTimeoutMs),
  }),
);

if (!baseUrl || !email || !password || !expectedNonce || !prompt) {
  throw new Error("Missing required OPENWEBUI_* environment variables");
}
if (smokeMode !== "models" && smokeMode !== "chat") {
  throw new Error(`Unsupported OPENWEBUI_SMOKE_MODE: ${smokeMode}`);
}

function readPositiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const text = raw.trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`${name} must be a positive integer; got: ${raw}`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer; got: ${raw}`);
  }
  return parsed;
}

function readNonNegativeInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const text = raw.trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`${name} must be a non-negative integer; got: ${raw}`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer; got: ${raw}`);
  }
  return parsed;
}

function clampTimerTimeoutMs(valueMs, minMs = 1) {
  const min = Math.max(0, Math.floor(minMs));
  const value = Number.isFinite(valueMs) ? valueMs : min;
  return Math.min(Math.max(Math.floor(value), min), MAX_TIMER_TIMEOUT_MS);
}

function readPositiveTimerMs(name, fallback) {
  return clampTimerTimeoutMs(readPositiveInt(name, fallback));
}

function readNonNegativeTimerMs(name, fallback) {
  return clampTimerTimeoutMs(readNonNegativeInt(name, fallback), 0);
}

function createTimeoutError(label, timeoutMs) {
  const error = new Error(`${label} timed out after ${timeoutMs}ms`);
  error.code = "ETIMEDOUT";
  return error;
}

async function withRequestTimeout(label, timeoutMs, run) {
  const resolvedTimeoutMs = clampTimerTimeoutMs(timeoutMs);
  const controller = new AbortController();
  const timeoutError = createTimeoutError(label, resolvedTimeoutMs);
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, resolvedTimeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([run(controller.signal, timeoutPromise), timeoutPromise]);
  } catch (error) {
    if (controller.signal.aborted) {
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedResponseText(response, label, timeoutPromise) {
  return await readBoundedResponseTextWithLimit(
    response,
    label,
    responseBodyMaxBytes,
    timeoutPromise,
  );
}

async function readBoundedResponseJson(response, label, timeoutPromise) {
  const body = await readBoundedResponseText(response, label, timeoutPromise);
  try {
    return JSON.parse(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} returned invalid JSON: ${message}`, { cause: error });
  }
}

function getCookieHeader(res) {
  const raw = res.headers.get("set-cookie");
  if (!raw) {
    return "";
  }
  return raw
    .split(/,(?=[^;]+=[^;]+)/g)
    .map((part) => part.split(";", 1)[0]?.trim())
    .filter(Boolean)
    .join("; ");
}

function buildAuthHeaders(token, cookie) {
  const headers = {};
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  if (cookie) {
    headers.cookie = cookie;
  }
  return headers;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, clampTimerTimeoutMs(ms, 0));
  });
}

function redactDiagnosticText(text, extraSecrets = []) {
  let redacted = text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer <redacted>")
    .replace(/openwebui-session=[^;"\s]+/giu, "openwebui-session=<redacted>");
  for (const secret of [email, password, ...extraSecrets]) {
    if (!secret) {
      continue;
    }
    redacted = redacted.replace(new RegExp(escapeRegExp(secret), "g"), "<redacted>");
    redacted = redacted.replace(
      new RegExp(escapeRegExp(JSON.stringify(secret).slice(1, -1)), "g"),
      "<redacted>",
    );
  }
  return redacted;
}

function cookieSecretValues(cookieHeader) {
  if (!cookieHeader) {
    return [];
  }
  return cookieHeader
    .split(";")
    .map((part) => {
      const text = part.trim();
      const separatorIndex = text.indexOf("=");
      return separatorIndex === -1 ? "" : text.slice(separatorIndex + 1).trim();
    })
    .filter(Boolean);
}

function authDiagnosticSecretValues(authHeaders) {
  const authorization =
    typeof authHeaders.authorization === "string" ? authHeaders.authorization : "";
  const bearerToken = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const cookie = typeof authHeaders.cookie === "string" ? authHeaders.cookie : "";
  return [bearerToken, authorization, cookie, ...cookieSecretValues(cookie)].filter(Boolean);
}

async function fetchSignin() {
  return await withRequestTimeout(
    "Open WebUI signin",
    controlTimeoutMs,
    async (signal, timeoutPromise) => {
      const response = await fetch(`${baseUrl}/api/v1/auths/signin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
        signal,
      });
      if (!response.ok) {
        const body = await readBoundedResponseText(response, "Open WebUI signin", timeoutPromise);
        throw new Error(`signin failed: HTTP ${response.status} ${redactDiagnosticText(body)}`);
      }
      return {
        cookie: getCookieHeader(response),
        json: await readBoundedResponseJson(response, "Open WebUI signin", timeoutPromise),
      };
    },
  );
}

async function fetchModels(authHeaders, attempt, diagnosticSecrets) {
  return await withRequestTimeout(
    `Open WebUI models attempt ${attempt}`,
    controlTimeoutMs,
    async (signal, timeoutPromise) => {
      const response = await fetch(`${baseUrl}/api/models`, { headers: authHeaders, signal });
      if (!response.ok) {
        const text = await readBoundedResponseText(
          response,
          `Open WebUI models attempt ${attempt}`,
          timeoutPromise,
        );
        return {
          ok: false,
          status: response.status,
          text: redactDiagnosticText(text, diagnosticSecrets),
        };
      }
      return {
        json: await readBoundedResponseJson(
          response,
          `Open WebUI models attempt ${attempt}`,
          timeoutPromise,
        ),
        ok: true,
      };
    },
  );
}

async function fetchChatCompletion(authHeaders, targetModel, diagnosticSecrets) {
  return await withRequestTimeout(
    "Open WebUI chat completion",
    chatTimeoutMs,
    async (signal, timeoutPromise) => {
      const response = await fetch(`${baseUrl}/api/chat/completions`, {
        method: "POST",
        headers: {
          ...authHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: targetModel,
          messages: [{ role: "user", content: prompt }],
        }),
        signal,
      });
      if (!response.ok) {
        const body = await readBoundedResponseText(
          response,
          "Open WebUI chat completion",
          timeoutPromise,
        );
        throw new Error(
          `/api/chat/completions failed: HTTP ${response.status} ${redactDiagnosticText(
            body,
            diagnosticSecrets,
          )}`,
        );
      }
      return await readBoundedResponseJson(response, "Open WebUI chat completion", timeoutPromise);
    },
  );
}

function extractModelIds(modelsJson) {
  const models = Array.isArray(modelsJson)
    ? modelsJson
    : Array.isArray(modelsJson?.data)
      ? modelsJson.data
      : Array.isArray(modelsJson?.models)
        ? modelsJson.models
        : [];
  return models
    .map((entry) => entry?.id ?? entry?.model ?? entry?.name)
    .filter((value) => typeof value === "string");
}

const signin = await fetchSignin();
const signinJson = signin.json;
const token =
  signinJson?.token ?? signinJson?.access_token ?? signinJson?.jwt ?? signinJson?.data?.token ?? "";
const authHeaders = {
  ...buildAuthHeaders(token, signin.cookie),
  accept: "application/json",
};
const diagnosticSecrets = [token, signin.cookie, ...cookieSecretValues(signin.cookie)];

let modelIds = [];
let targetModel = "";
let lastModelsError = "";
for (let attempt = 1; attempt <= modelAttempts; attempt += 1) {
  const modelsResult = await fetchModels(authHeaders, attempt, diagnosticSecrets).catch(
    /** @param {unknown} error */ (error) => {
      lastModelsError = error instanceof Error ? error.message : String(error);
      return undefined;
    },
  );
  if (modelsResult?.ok) {
    modelIds = extractModelIds(modelsResult.json);
    targetModel =
      modelIds.find((id) => id === "openclaw/default") ?? modelIds.find((id) => id === "openclaw");
    if (targetModel) {
      break;
    }
    lastModelsError = `missing openclaw model: ${JSON.stringify(modelIds)}`;
  } else if (modelsResult) {
    lastModelsError = `HTTP ${modelsResult.status} ${modelsResult.text}`;
  }
  if (attempt < modelAttempts) {
    await sleep(modelRetryMs);
  }
}
if (!targetModel) {
  throw new Error(
    `openclaw model missing from Open WebUI model list after retry: ${JSON.stringify(modelIds)} (${lastModelsError})`,
  );
}
if (smokeMode === "models") {
  console.log(JSON.stringify({ ok: true, mode: smokeMode, model: targetModel }, null, 2));
  process.exit(0);
}

const chatJson = await fetchChatCompletion(authHeaders, targetModel, diagnosticSecrets);
const reply =
  chatJson?.choices?.[0]?.message?.content ?? chatJson?.message?.content ?? chatJson?.content ?? "";
if (typeof reply !== "string" || !reply.includes(expectedNonce)) {
  const diagnosticReply = redactDiagnosticText(JSON.stringify(reply), [
    ...diagnosticSecrets,
    ...authDiagnosticSecretValues(authHeaders),
  ]);
  throw new Error(`chat reply missing nonce: ${diagnosticReply}`);
}

console.log(JSON.stringify({ ok: true, model: targetModel, reply }, null, 2));
