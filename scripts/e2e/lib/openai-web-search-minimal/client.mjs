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

const DEFAULT_RAW_SCHEMA_ERROR =
  "400 The following tools cannot be used with reasoning.effort 'minimal': web_search.";
const DEFAULT_GATEWAY_SCHEMA_ERROR = "provider rejected the request schema or tool payload";

function readExpectedRawSchemaError() {
  return process.env.RAW_SCHEMA_ERROR?.trim() || DEFAULT_RAW_SCHEMA_ERROR;
}

async function gatewayAgent(params) {
  const port = process.env.PORT;
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!port || !token) {
    throw new Error("missing PORT/OPENCLAW_GATEWAY_TOKEN");
  }

  try {
    const callGateway = await loadCallGateway();
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

function stringifyError(value) {
  return value instanceof Error ? value.message || String(value) : String(value);
}

function validateRejectResult(result, expectedRawSchemaError = readExpectedRawSchemaError()) {
  if (result.ok) {
    throw new Error(`reject mode unexpectedly completed: ${JSON.stringify(result.value)}`);
  }
  const errorText = stringifyError(result.error);
  if (
    !errorText.includes(expectedRawSchemaError) &&
    !errorText.includes(DEFAULT_GATEWAY_SCHEMA_ERROR)
  ) {
    throw new Error(
      `reject mode failed for an unexpected reason; expected ${JSON.stringify(
        expectedRawSchemaError,
      )} or ${JSON.stringify(DEFAULT_GATEWAY_SCHEMA_ERROR)} in ${JSON.stringify(errorText)}`,
    );
  }
  return errorText;
}

async function main() {
  const mode = process.argv[2];
  const sessionKey = `agent:main:openai-web-search-minimal:${mode}`;
  const message =
    mode === "reject" ? "FORCE_SCHEMA_REJECT" : "Return exactly OPENCLAW_SCHEMA_E2E_OK.";
  const id = mode === "reject" ? "schema-reject" : "schema-success";

  const result = await gatewayAgent({
    sessionKey,
    message,
    thinking: "minimal",
    deliver: false,
    timeout: 180,
    idempotencyKey: id,
  });

  if (mode === "reject") {
    console.error(validateRejectResult(result));
    return;
  }
  if (!result.ok) {
    throw toLintErrorObject(result.error, "Non-Error thrown");
  }
  if (result.value?.status !== "ok") {
    throw new Error(`agent run did not complete successfully: ${JSON.stringify(result.value)}`);
  }
}

function toLintErrorObject(value, fallbackMessage) {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  }
}

export const testing = {
  DEFAULT_GATEWAY_SCHEMA_ERROR,
  DEFAULT_RAW_SCHEMA_ERROR,
  validateRejectResult,
};
