// Qa Lab plugin module proves authenticated non-model Tool Search batches.
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { fetchQaFixtureJson } from "./fixture-utils.js";
import { liveTurnTimeoutMs } from "./suite-runtime-agent-common.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

type ToolSearchGatewayFixture = {
  fakePluginDir: string;
  targetTool: string;
};

type GatewayBatchResult = {
  candidateNames: string[][];
  queryCount: number;
  targetFound: boolean;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function parseJson(text: string | undefined): unknown {
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function runToolSearchGatewayBatchInvoke(params: {
  env: QaSuiteRuntimeEnv;
  fixture: ToolSearchGatewayFixture;
}): Promise<GatewayBatchResult> {
  const gatewayToken = params.env.gateway.runtimeEnv.OPENCLAW_GATEWAY_TOKEN;
  assert(gatewayToken, "Tool Search gateway fixture requires QA gateway token");
  const response = await fetchQaFixtureJson(
    `${params.env.gateway.baseUrl}/tools/invoke`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${gatewayToken}`,
        "content-type": "application/json",
        "x-openclaw-scopes": "operator.write",
      },
      body: JSON.stringify({
        name: "tool_search",
        agentId: "qa",
        sessionKey: "tool-search-gateway-tools",
        args: {
          queries: [
            { query: params.fixture.targetTool, limit: 3 },
            { query: "fake plugin tool 01", limit: 2 },
          ],
        },
      }),
    },
    { timeoutMs: liveTurnTimeoutMs(params.env, 30_000) },
  );
  assert(isRecord(response) && response.ok === true, "Gateway batch invoke did not return ok");
  const result = isRecord(response.result) ? response.result : undefined;
  const content = result && Array.isArray(result.content) ? result.content : [];
  const firstContent = content.find(
    (item): item is Record<string, unknown> => isRecord(item) && typeof item.text === "string",
  );
  const payload = parseJson(typeof firstContent?.text === "string" ? firstContent.text : undefined);
  const results = isRecord(payload) && Array.isArray(payload.results) ? payload.results : [];
  const candidateNames = results.map((entry) => {
    const candidates = isRecord(entry) && Array.isArray(entry.candidates) ? entry.candidates : [];
    return candidates.flatMap((candidate) => {
      if (!isRecord(candidate)) {
        return [];
      }
      const name = candidate.name ?? candidate.id;
      return typeof name === "string" ? [name] : [];
    });
  });
  const targetFound = candidateNames.some((names) => names.includes(params.fixture.targetTool));
  assert(results.length === 2, `Gateway batch invoke returned ${results.length} result groups`);
  assert(targetFound, `Gateway batch invoke did not discover ${params.fixture.targetTool}`);
  return {
    candidateNames,
    queryCount: results.length,
    targetFound,
  };
}
