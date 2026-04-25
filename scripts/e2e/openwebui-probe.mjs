const baseUrl = process.env.OPENWEBUI_BASE_URL ?? "";
const email = process.env.OPENWEBUI_ADMIN_EMAIL ?? "";
const password = process.env.OPENWEBUI_ADMIN_PASSWORD ?? "";
const expectedNonce = process.env.OPENWEBUI_EXPECTED_NONCE ?? "";
const prompt = process.env.OPENWEBUI_PROMPT ?? "";
const modelAttempts = Number.parseInt(process.env.OPENWEBUI_MODEL_ATTEMPTS ?? "72", 10);
const modelRetryMs = Number.parseInt(process.env.OPENWEBUI_MODEL_RETRY_MS ?? "5000", 10);

if (!baseUrl || !email || !password || !expectedNonce || !prompt) {
  throw new Error("Missing required OPENWEBUI_* environment variables");
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

const signinRes = await fetch(`${baseUrl}/api/v1/auths/signin`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password }),
});
if (!signinRes.ok) {
  const body = await signinRes.text();
  throw new Error(`signin failed: HTTP ${signinRes.status} ${body}`);
}

const signinJson = await signinRes.json();
const token =
  signinJson?.token ?? signinJson?.access_token ?? signinJson?.jwt ?? signinJson?.data?.token ?? "";
const cookie = getCookieHeader(signinRes);
const authHeaders = {
  ...buildAuthHeaders(token, cookie),
  accept: "application/json",
};

let modelIds = [];
let targetModel = "";
let lastModelsError = "";
for (let attempt = 1; attempt <= modelAttempts; attempt += 1) {
  const modelsRes = await fetch(`${baseUrl}/api/models`, { headers: authHeaders }).catch(
    (error) => {
      lastModelsError = error instanceof Error ? error.message : String(error);
      return undefined;
    },
  );
  if (modelsRes?.ok) {
    const modelsJson = await modelsRes.json();
    modelIds = extractModelIds(modelsJson);
    targetModel =
      modelIds.find((id) => id === "openclaw/default") ?? modelIds.find((id) => id === "openclaw");
    if (targetModel) {
      break;
    }
    lastModelsError = `missing openclaw model: ${JSON.stringify(modelIds)}`;
  } else if (modelsRes) {
    lastModelsError = `HTTP ${modelsRes.status} ${await modelsRes.text()}`;
  }
  await sleep(modelRetryMs);
}
if (!targetModel) {
  throw new Error(
    `openclaw model missing from Open WebUI model list after retry: ${JSON.stringify(modelIds)} (${lastModelsError})`,
  );
}

const chatRes = await fetch(`${baseUrl}/api/chat/completions`, {
  method: "POST",
  headers: {
    ...authHeaders,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    model: targetModel,
    messages: [{ role: "user", content: prompt }],
  }),
});
if (!chatRes.ok) {
  throw new Error(`/api/chat/completions failed: HTTP ${chatRes.status} ${await chatRes.text()}`);
}
const chatJson = await chatRes.json();
const reply =
  chatJson?.choices?.[0]?.message?.content ?? chatJson?.message?.content ?? chatJson?.content ?? "";
if (typeof reply !== "string" || !reply.includes(expectedNonce)) {
  throw new Error(`chat reply missing nonce: ${JSON.stringify(reply)}`);
}

console.log(JSON.stringify({ ok: true, model: targetModel, reply }, null, 2));
