import fs from "node:fs";

const command = process.argv[2];

function assertPatchBehavior() {
  return import("../../../../dist/extensions/openai/native-web-search.js").then(
    ({ patchOpenAINativeWebSearchPayload }) => {
      const injectedPayload = {
        reasoning: { effort: "minimal", summary: "auto" },
      };
      const injectedResult = patchOpenAINativeWebSearchPayload(injectedPayload);
      if (injectedResult !== "injected") {
        throw new Error(`expected native web_search injection, got ${injectedResult}`);
      }
      if (injectedPayload.reasoning.effort !== "low") {
        throw new Error(
          `expected injected native web_search to raise minimal reasoning to low, got ${JSON.stringify(injectedPayload.reasoning)}`,
        );
      }
      if (!injectedPayload.tools?.some((tool) => tool?.type === "web_search")) {
        throw new Error(`native web_search was not injected: ${JSON.stringify(injectedPayload)}`);
      }

      const existingNativePayload = {
        tools: [{ type: "web_search" }],
        reasoning: { effort: "minimal" },
      };
      const existingResult = patchOpenAINativeWebSearchPayload(existingNativePayload);
      if (existingResult !== "native_tool_already_present") {
        throw new Error(`expected existing native web_search, got ${existingResult}`);
      }
      if (existingNativePayload.reasoning.effort !== "low") {
        throw new Error(
          `expected existing native web_search to raise minimal reasoning to low, got ${JSON.stringify(existingNativePayload.reasoning)}`,
        );
      }
    },
  );
}

function assertSuccessRequest() {
  const logPath = process.argv[3];
  const entries = fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split(/\n+/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const responseEntries = entries.filter((entry) => entry.path === "/v1/responses");
  if (responseEntries.length < 1) {
    throw new Error(`mock OpenAI /v1/responses was not used. Requests: ${JSON.stringify(entries)}`);
  }
  const success = responseEntries.find((entry) =>
    JSON.stringify(entry.body).includes("OPENCLAW_SCHEMA_E2E_OK"),
  );
  if (!success) {
    throw new Error(`missing success request. Requests: ${JSON.stringify(responseEntries)}`);
  }
  const tools = Array.isArray(success.body.tools) ? success.body.tools : [];
  const hasWebSearch = tools.some(
    (tool) =>
      tool?.type === "web_search" ||
      (tool?.type === "function" &&
        (tool?.name === "web_search" || tool?.function?.name === "web_search")),
  );
  if (!hasWebSearch) {
    throw new Error(
      `success request did not include web_search. Body: ${JSON.stringify(success.body)}`,
    );
  }
  if (success.body.reasoning?.effort === "minimal") {
    throw new Error(
      `expected web_search request to avoid minimal reasoning, got ${JSON.stringify(success.body.reasoning)}`,
    );
  }
}

const commands = {
  "assert-patch-behavior": assertPatchBehavior,
  "assert-success-request": assertSuccessRequest,
};

const fn = commands[command];
if (!fn) {
  throw new Error(`unknown OpenAI web-search minimal assertion command: ${command}`);
}
await fn();
