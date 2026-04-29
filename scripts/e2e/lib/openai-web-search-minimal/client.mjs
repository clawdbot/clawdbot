import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

async function loadCallGateway() {
  const candidates = readdirSync("/app/dist")
    .filter((name) => /^call(?:\.runtime)?-[A-Za-z0-9_-]+\.js$/.test(name))
    .toSorted();
  for (const name of candidates) {
    const mod = await import(pathToFileURL(`/app/dist/${name}`).href);
    if (typeof mod.callGateway === "function") {
      return mod.callGateway;
    }
  }
  throw new Error(`unable to find callGateway export in /app/dist (${candidates.join(", ")})`);
}

const callGateway = await loadCallGateway();

const port = process.env.PORT;
const token = process.env.OPENCLAW_GATEWAY_TOKEN;
const mode = process.argv[2];
const sessionKey = `agent:main:openai-web-search-minimal:${mode}`;
const message =
  mode === "reject" ? "FORCE_SCHEMA_REJECT" : "Return exactly OPENCLAW_SCHEMA_E2E_OK.";
const id = mode === "reject" ? "schema-reject" : "schema-success";

if (!port || !token) {
  throw new Error("missing PORT/OPENCLAW_GATEWAY_TOKEN");
}

async function gatewayAgent(params) {
  try {
    return {
      ok: true,
      value: await callGateway({
        url: `ws://127.0.0.1:${port}`,
        token,
        method: "agent",
        params,
        expectFinal: true,
        timeoutMs: 240_000,
        clientName: "gateway-client",
        mode: "backend",
        scopes: ["operator.write"],
        deviceIdentity: null,
      }),
    };
  } catch (error) {
    const combined = String(error);
    return { ok: false, error: new Error(combined) };
  }
}

const result = await gatewayAgent({
  sessionKey,
  message,
  thinking: "minimal",
  deliver: false,
  timeout: 180,
  idempotencyKey: id,
});

if (mode === "reject") {
  console.error(result.ok ? JSON.stringify(result.value) : String(result.error));
  process.exit(0);
}
if (!result.ok) {
  throw result.error;
}
if (result.value?.status !== "ok") {
  throw new Error(`agent run did not complete successfully: ${JSON.stringify(result.value)}`);
}
