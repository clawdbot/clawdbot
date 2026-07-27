// Mcp Code Mode Gateway Client script supports OpenClaw repository automation.
import path from "node:path";
import { setTimeout as setNodeTimeout, clearTimeout as clearNodeTimeout } from "node:timers";
import { pathToFileURL } from "node:url";
import { readBoundedResponseText } from "../lib/bounded-response.ts";
import { readPositiveIntEnv } from "./lib/env-limits.mjs";
import {
  type McpCodeModeMentions,
  validateMcpCodeModeResult,
} from "./lib/mcp-code-mode-validation.ts";
import { countSessionLogMentions } from "./lib/session-log-mentions.ts";

type FetchJsonOptions = {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  maxBodyBytes?: number;
  timeoutMs?: number;
};

type McpCodeModeClientFetchLimits = {
  bodyMaxBytes: number;
  timeoutMs: number;
};

export function readMcpCodeModeClientFetchLimits(
  env: NodeJS.ProcessEnv = process.env,
): McpCodeModeClientFetchLimits {
  return {
    bodyMaxBytes: readPositiveIntEnv(
      "OPENCLAW_MCP_CODE_MODE_CLIENT_BODY_MAX_BYTES",
      1024 * 1024,
      env,
    ),
    timeoutMs: readPositiveIntEnv("OPENCLAW_MCP_CODE_MODE_CLIENT_TIMEOUT_MS", 300_000, env),
  };
}

const DEFAULT_FETCH_LIMITS = readMcpCodeModeClientFetchLimits();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function taggedError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

export async function fetchJson(
  url: string,
  init: RequestInit = {},
  options: FetchJsonOptions = {},
): Promise<unknown> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_FETCH_LIMITS.timeoutMs);
  const maxBodyBytes = Math.max(1, options.maxBodyBytes ?? DEFAULT_FETCH_LIMITS.bodyMaxBytes);
  const controller = new AbortController();
  const timeoutError = taggedError(
    `HTTP request to ${url} timed out after ${timeoutMs}ms`,
    "ETIMEDOUT",
  );
  let timeout: ReturnType<typeof setNodeTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setNodeTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
    timeout.unref?.();
  });
  let response: Response | undefined;
  let text = "";
  try {
    response = await Promise.race([
      (options.fetchImpl ?? fetch)(url, { ...init, signal: controller.signal }),
      timeoutPromise,
    ]);
    text = await readBoundedResponseText(response, url, maxBodyBytes, {
      createTooLargeError(message) {
        return taggedError(message, "ETOOBIG");
      },
      formatTooLargeMessage(targetUrl, byteLimit) {
        return `HTTP response from ${targetUrl} exceeded ${byteLimit} bytes`;
      },
      signal: controller.signal,
      timeoutPromise,
    });
  } finally {
    if (timeout) {
      clearNodeTimeout(timeout);
    }
  }
  if (!response) {
    throw new Error(`HTTP request to ${url} did not return a response`);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

async function readSessionLogMentions(stateDir: string): Promise<Record<string, number>> {
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  return await countSessionLogMentions({
    sessionsDir,
    needles: {
      apiCall: "MCP.$api",
      apiFileList: "API.list",
      apiFileRead: "API.read",
      mcpNamespace: "MCP.fixture",
      mcpTool: "fixture__lookup_note",
      toolSearchPollution: 'tools.search("lookup note"',
    },
  });
}

async function main() {
  const gatewayUrl = process.env.GW_URL?.trim();
  const gatewayToken = process.env.GW_TOKEN?.trim();
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  const model = process.env.OPENCLAW_MCP_CODE_MODE_MODEL?.trim() || "openclaw/main";
  assert(gatewayUrl, "missing GW_URL");
  assert(gatewayToken, "missing GW_TOKEN");
  assert(stateDir, "missing OPENCLAW_STATE_DIR");

  const response = await fetchJson(`${gatewayUrl.replace(/\/$/, "")}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${gatewayToken}`,
      "content-type": "application/json",
      "x-openclaw-agent": "main",
      "x-openclaw-scopes": "operator.write",
    },
    body: JSON.stringify({
      model,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "mcp code mode api file qa check:",
                "MCP and API are code-mode globals; they are defined only inside the exec tool, not in normal chat.",
                "Call exec with language javascript and this exact code:",
                'const files = await API.list("mcp");',
                'const root = await API.read("mcp/index.d.ts");',
                'const api = await API.read("mcp/fixture.d.ts");',
                'const result = await MCP.fixture.lookupNote({ id: "alpha" });',
                'return { marker: "MCP_CODE_MODE_FILE_TOOL_RESULT", files: files.files.map((file) => file.path), rootHasFixture: root.content.includes("fixture"), headerHasLookup: api.content.includes("function lookupNote"), note: result.content?.[0]?.text };',
                "Do not use tools.search for MCP and do not call the inline MCP API helper.",
                "After exec finishes, send a normal assistant reply; do not stop after only the tool call.",
                "Reply with MCP_CODE_MODE_FILE_OK note=fixture-note-alpha unclear=none only after the MCP call returns fixture-note-alpha.",
              ].join(" "),
            },
          ],
        },
      ],
      max_output_tokens: 1024,
      stream: false,
    }),
  });
  const mentions = await readSessionLogMentions(stateDir);
  const finalText = validateMcpCodeModeResult(response, mentions as McpCodeModeMentions);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        gatewayUrl,
        finalText,
        sessionLogMentions: mentions,
      },
      null,
      2,
    )}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
