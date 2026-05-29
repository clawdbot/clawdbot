import { Agent, setGlobalDispatcher } from "undici";

const baseUrl = process.env.OPENWEBUI_BASE_URL ?? "";
const email = process.env.OPENWEBUI_ADMIN_EMAIL ?? "";
const password = process.env.OPENWEBUI_ADMIN_PASSWORD ?? "";
const expectedNonce = process.env.OPENWEBUI_EXPECTED_NONCE ?? "";
const prompt = process.env.OPENWEBUI_PROMPT ?? "";
const modelAttempts = readPositiveInt("OPENWEBUI_MODEL_ATTEMPTS", 72);
const modelRetryMs = readNonNegativeInt("OPENWEBUI_MODEL_RETRY_MS", 5000);
const fetchTimeoutMs = readPositiveInt("OPENWEBUI_FETCH_TIMEOUT_MS", 720000);
const controlTimeoutMs = readPositiveInt(
  "OPENWEBUI_CONTROL_TIMEOUT_MS",
  Math.min(fetchTimeoutMs, 30000),
);
const chatTimeoutMs = readPositiveInt("OPENWEBUI_CHAT_TIMEOUT_MS", fetchTimeoutMs);
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

function createTimeoutError(label, timeoutMs) {
  const error = new Error(`${label} timed out after ${timeoutMs}ms`);
  error.code = "ETIMEDOUT";
  return error;
}

function createBodyTooLargeError(label, byteLimit) {
  const error = new Error(`${label} response body exceeded ${byteLimit} bytes`);
  error.code = "ETOOBIG";
  return error;
}

async function withRequestTimeout(label, timeoutMs, run) {
  const controller = new AbortController();
  const timeoutError = createTimeoutError(label, timeoutMs);
  const timer = setTimeout(() => {
    controller.abort(timeoutError);
  }, timeoutMs);
  timer.unref?.();
  try {
    return await run(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedResponseText(response, label, byteLimit = responseBodyMaxBytes) {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (Number.isSafeInteger(parsedLength) && parsedLength > byteLimit) {
      await response.body?.cancel().catch(() => {});
      throw createBodyTooLargeError(label, byteLimit);
    }
  }
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteCount = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return text + decoder.decode();
      }
      byteCount += value.byteLength;
      if (byteCount > byteLimit) {
        await reader.cancel().catch(() => {});
        throw createBodyTooLargeError(label, byteLimit);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

async function readBoundedResponseJson(response, label) {
  const body = await readBoundedResponseText(response, label);
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
    setTimeout(resolve, ms);
  });
}

async function fetchSignin() {
  return await withRequestTimeout("Open WebUI signin", controlTimeoutMs, async (signal) => {
    const response = await fetch(`${baseUrl}/api/v1/auths/signin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
      signal,
    });
    if (!response.ok) {
      const body = await readBoundedResponseText(response, "Open WebUI signin");
      throw new Error(`signin failed: HTTP ${response.status} ${body}`);
    }
    return {
      cookie: getCookieHeader(response),
      json: await readBoundedResponseJson(response, "Open WebUI signin"),
    };
  });
}

async function fetchModels(authHeaders, attempt) {
  return await withRequestTimeout(
    `Open WebUI models attempt ${attempt}`,
    controlTimeoutMs,
    async (signal) => {
      const response = await fetch(`${baseUrl}/api/models`, { headers: authHeaders, signal });
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          text: await readBoundedResponseText(response, `Open WebUI models attempt ${attempt}`),
        };
      }
      return {
        json: await readBoundedResponseJson(response, `Open WebUI models attempt ${attempt}`),
        ok: true,
      };
    },
  );
}

async function fetchChatCompletion(authHeaders, targetModel) {
  return await withRequestTimeout("Open WebUI chat completion", chatTimeoutMs, async (signal) => {
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
      const body = await readBoundedResponseText(response, "Open WebUI chat completion");
      throw new Error(`/api/chat/completions failed: HTTP ${response.status} ${body}`);
    }
    return await readBoundedResponseJson(response, "Open WebUI chat completion");
  });
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

let modelIds = [];
let targetModel = "";
let lastModelsError = "";
for (let attempt = 1; attempt <= modelAttempts; attempt += 1) {
  const modelsResult = await fetchModels(authHeaders, attempt).catch((error) => {
    lastModelsError = error instanceof Error ? error.message : String(error);
    return undefined;
  });
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

const chatJson = await fetchChatCompletion(authHeaders, targetModel);
const reply =
  chatJson?.choices?.[0]?.message?.content ?? chatJson?.message?.content ?? chatJson?.content ?? "";
if (typeof reply !== "string" || !reply.includes(expectedNonce)) {
  throw new Error(`chat reply missing nonce: ${JSON.stringify(reply)}`);
}

console.log(JSON.stringify({ ok: true, model: targetModel, reply }, null, 2));
