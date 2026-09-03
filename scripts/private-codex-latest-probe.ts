// Parent-operated acceptance client: no config loaders, local servers, or credential files.
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import { z } from "zod";
import { rawDataToString } from "../packages/gateway-client/src/websocket-data.ts";
import { PROTOCOL_VERSION } from "../packages/gateway-protocol/src/version.ts";

const ALIAS = "codex-latest";
const SENTINEL = "synthetic-private-probe-selector";
const MAX_BYTES = 1_048_576;
const headersSchema = z.record(z.string().max(128), z.string().max(8192));
const inputSchema = z.strictObject({
  isolatedCellReady: z.literal(true),
  verifiedExternalProxyReady: z.literal(true),
  allowInference: z.literal(true),
  gatewayUrl: z.url(),
  facadeBase: z.url(),
  ownerHeaders: headersSchema,
  nonownerHeaders: headersSchema,
  workloadToken: z.string().min(1).max(8192),
  openclawAgent: z.string().regex(/^[a-z0-9-]{1,64}$/),
  codexAgent: z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/)
    .optional(),
  nativeSafetyContractApproved: z.boolean().default(false),
  privateTarget: z.string().min(8).max(512).optional(),
});
type ProbeInput = z.infer<typeof inputSchema>;
const frameSchema = z.object({
  type: z.string(),
  id: z.string().optional(),
  event: z.string().optional(),
  ok: z.boolean().optional(),
  payload: z.unknown().optional(),
  error: z.object({ details: z.object({ code: z.string().optional() }).optional() }).optional(),
});
const recordSchema = z.record(z.string(), z.unknown());
const reportTemplate = {
  schema_version: 1,
  preflight_pass: 0,
  owner_admitted: 0,
  nonowner_denied: 0,
  facade_catalog_pass: 0,
  raw_model_rejected: 0,
  malformed_request_rejected: 0,
  alias_sse_pass: 0,
  openclaw_picker_pass: 0,
  openclaw_runtime_pass: 0,
  openclaw_tool_pass: 0,
  openclaw_second_turn_pass: 0,
  codex_picker_pass: 0,
  codex_runtime_pass: 0,
  codex_tool_pass: 0,
  codex_second_turn_pass: 0,
  native_blocked: 1,
  native_restart_resume_tested: 0,
  persisted_state_scanned: 0,
  report_scanned: 0,
  observed_bytes: 0,
  leak_hits: 0,
  explicit_model_failures: 0,
  errors: 0,
  protocol_pass: 0,
};
type ProbeReport = typeof reportTemplate;

function observe(text: string, needles: string[], report: ProbeReport) {
  report.observed_bytes += Buffer.byteLength(text);
  if (report.observed_bytes > 16 * MAX_BYTES) {
    report.errors++;
    throw new Error("budget");
  }
  // Scan both raw wire text and decoded JSON strings; never include matches in an error.
  const inspect = (value: unknown): void => {
    const remaining = [value];
    while (remaining.length) {
      const item = remaining.pop();
      if (typeof item === "string") {
        if (
          needles.some(
            (needle) => item.includes(needle) || item.includes(encodeURIComponent(needle)),
          )
        ) {
          report.leak_hits++;
        }
      } else if (item && typeof item === "object") {
        for (const [key, child] of Object.entries(item)) {
          if (
            ["model", "model_id", "modelid", "upstream", "openai-model", "retry_model"].includes(
              key.toLowerCase(),
            ) &&
            typeof child === "string" &&
            ![ALIAS, `openai/${ALIAS}`, `clawrouter/${ALIAS}`].includes(child)
          ) {
            report.explicit_model_failures++;
          }
          remaining.push(key, child);
        }
      }
    }
  };
  inspect(text);
  try {
    inspect(JSON.parse(text));
  } catch {
    /* Malformed bodies still get the raw scan. */
  }
}

async function readResponse(response: Response, scan: (value: string) => void) {
  scan(JSON.stringify(Object.fromEntries(response.headers)));
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  let body = "";
  let bytes = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) {
        throw new Error("budget");
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    scan(body);
    for (const line of body.split(/\r?\n/u)) {
      if (line.startsWith("data: ")) {
        scan(line.slice(6));
      }
    }
    return body;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function gatewayClient(url: string, headers: Record<string, string>, scan: (text: string) => void) {
  const ws = new WebSocket(url, {
    headers,
    handshakeTimeout: 12_000,
    maxPayload: MAX_BYTES,
    followRedirects: false,
  });
  const pending = new Map<
    string,
    {
      resolve: (value: z.infer<typeof frameSchema>) => void;
      reject: () => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let denied = false;
  let challengeResolve: () => void;
  let challengeReject: () => void;
  const challenge = new Promise<void>((resolve, reject) => {
    challengeResolve = resolve;
    challengeReject = reject;
  });
  const timer = setTimeout(() => {
    challengeReject();
    ws.terminate();
  }, 12_000);
  const fail = () => {
    challengeReject();
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject();
    }
    pending.clear();
  };
  const scanFrame = (text: string) => {
    try {
      scan(text);
    } catch {
      fail();
      ws.terminate();
    }
  };
  ws.on("unexpected-response", (_request, response) => {
    scanFrame(JSON.stringify(response.headers));
    denied = response.statusCode === 401 || response.statusCode === 403;
    let body = "";
    let bytes = 0;
    const decoder = new TextDecoder();
    response.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_BYTES) {
        denied = false;
        response.destroy();
        fail();
        return;
      }
      body += decoder.decode(chunk, { stream: true });
    });
    response.on("end", () => {
      body += decoder.decode();
      scanFrame(body);
      fail();
    });
    response.on("error", fail);
  });
  ws.on("upgrade", (response) => {
    scanFrame(JSON.stringify(response.headers));
  });
  ws.on("message", (data) => {
    try {
      const text = rawDataToString(data);
      scan(text);
      const frame = frameSchema.parse(JSON.parse(text));
      if (frame.type === "event" && frame.event === "connect.challenge") {
        challengeResolve();
      }
      if (frame.type === "res" && frame.id) {
        const waiter = pending.get(frame.id);
        if (waiter) {
          clearTimeout(waiter.timer);
          pending.delete(frame.id);
          waiter.resolve(frame);
        }
      }
    } catch {
      fail();
      ws.terminate();
    }
  });
  ws.on("error", fail);
  ws.on("close", (_code, reason) => {
    scanFrame(reason.toString("utf8"));
    fail();
  });
  async function request(method: string, params: unknown, timeoutMs = 12_000) {
    const id = randomUUID();
    return await new Promise<z.infer<typeof frameSchema>>((resolve, reject) => {
      const requestTimer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("timeout"));
      }, timeoutMs);
      pending.set(id, {
        resolve,
        reject: () => reject(new Error("transport")),
        timer: requestTimer,
      });
      ws.send(JSON.stringify({ type: "req", id, method, params }), (error) => {
        if (error) {
          fail();
        }
      });
    });
  }
  return {
    async connect() {
      try {
        await challenge;
        const response = await request("connect", {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: { id: "cli", version: "private-alias-probe", platform: "node", mode: "cli" },
          role: "operator",
          scopes: ["operator.read", "operator.write"],
          caps: [],
        });
        // Only an edge HTTP denial proves the owner fence ran before Gateway admission.
        return response.ok === true ? "admitted" : "failed";
      } catch {
        return denied ? "denied" : "failed";
      } finally {
        clearTimeout(timer);
      }
    },
    async rpc(method: string, params: unknown, timeoutMs?: number) {
      const response = await request(method, params, timeoutMs);
      if (response.ok !== true) {
        throw new Error("rpc");
      }
      return recordSchema.parse(response.payload);
    },
    close() {
      clearTimeout(timer);
      fail();
      ws.terminate();
    },
  };
}

const messageSchema = z.object({
  role: z.string(),
  content: z.unknown().optional(),
  toolCallId: z.string().optional(),
  isError: z.boolean().optional(),
});
const contentSchema = z.union([
  z.string(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);
const successfulToolResultSchema = messageSchema.extend({
  role: z.literal("toolResult"),
  isError: z.literal(false),
  toolCallId: z.string(),
  content: contentSchema,
});
function toolProof(messages: z.infer<typeof messageSchema>[], nonce: string) {
  const calls = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      const parsed = z.object({ type: z.literal("toolCall"), id: z.string() }).safeParse(part);
      if (parsed.success) {
        calls.add(parsed.data.id);
      }
    }
  }
  return messages.some((message) => {
    const result = successfulToolResultSchema.safeParse(message);
    return (
      result.success &&
      calls.has(result.data.toolCallId) &&
      JSON.stringify(result.data.content).includes(nonce)
    );
  });
}

async function probeHarness(
  input: ProbeInput,
  native: boolean,
  scan: (text: string) => void,
  report: ProbeReport,
) {
  const prefix = native ? "codex" : "openclaw";
  const agentId = native ? input.codexAgent : input.openclawAgent;
  if (!agentId) {
    throw new Error("agent");
  }
  let client = gatewayClient(input.gatewayUrl, input.ownerHeaders, scan);
  try {
    if ((await client.connect()) !== "admitted") {
      throw new Error("admission");
    }
    const catalog = await client.rpc("models.list", {
      agentId,
      preparedOnly: true,
      view: "configured",
    });
    const rows = z.array(z.object({ id: z.string(), name: z.string() })).parse(catalog.models);
    report[`${prefix}_picker_pass`] = Number(
      rows.some((row) => row.id === ALIAS && row.name === "Codex (Latest)"),
    );
    if (!report[`${prefix}_picker_pass`]) {
      return;
    }
    const created = await client.rpc("sessions.create", {
      agentId,
      idempotencyKey: randomUUID(),
      label: "Private alias acceptance probe",
      model: `${native ? "openai" : "clawrouter"}/${ALIAS}`,
    });
    const key = z.string().min(1).parse(created.key);
    const nonce = `probe-tool-${randomUUID()}`;
    const first = await client.rpc("sessions.send", {
      key,
      agentId,
      idempotencyKey: randomUUID(),
      message: `Run one read-only shell tool command: printf '%s' '${nonce}'. Do not read files or use the network. Then reply with its output.`,
    });
    const firstRun = z.string().parse(first.runId);
    const done = await client.rpc("agent.wait", { runId: firstRun, timeoutMs: 60_000 }, 65_000);
    if (done.status !== "ok") {
      throw new Error("turn");
    }
    const history = await client.rpc("chat.history", { sessionKey: key, agentId, limit: 100 });
    const runtimeSchema = z.object({
      model: z.literal(ALIAS),
      modelProvider: z.literal(native ? "openai" : "clawrouter"),
      agentRuntime: z.object({ id: z.literal(native ? "codex" : "openclaw") }),
    });
    report[`${prefix}_runtime_pass`] = Number(runtimeSchema.safeParse(history.sessionInfo).success);
    if (!report[`${prefix}_runtime_pass`]) {
      return;
    }
    const messages = z.array(messageSchema).parse(history.messages);
    report[`${prefix}_tool_pass`] = Number(toolProof(messages, nonce));
    if (!report[`${prefix}_tool_pass`]) {
      return;
    }
    client.close();
    client = gatewayClient(input.gatewayUrl, input.ownerHeaders, scan);
    if ((await client.connect()) !== "admitted") {
      throw new Error("admission");
    }
    const second = await client.rpc("sessions.send", {
      key,
      agentId,
      idempotencyKey: randomUUID(),
      message:
        "Reply with the exact nonce produced by the tool in the previous turn. Do not call tools.",
    });
    const secondDone = await client.rpc(
      "agent.wait",
      { runId: z.string().parse(second.runId), timeoutMs: 60_000 },
      65_000,
    );
    if (secondDone.status !== "ok") {
      throw new Error("turn");
    }
    const continued = await client.rpc("chat.history", { sessionKey: key, agentId, limit: 100 });
    if (!runtimeSchema.safeParse(continued.sessionInfo).success) {
      report[`${prefix}_runtime_pass`] = 0;
      return;
    }
    const next = z.array(messageSchema).parse(continued.messages);
    const previousAssistants = messages.filter((message) => message.role === "assistant").length;
    const assistants = next.filter((message) => message.role === "assistant");
    const last = z.object({ content: contentSchema }).safeParse(assistants.at(-1));
    report[`${prefix}_second_turn_pass`] = Number(
      assistants.length > previousAssistants &&
        last.success &&
        JSON.stringify(last.data.content).includes(nonce),
    );
  } finally {
    client.close();
  }
}

export async function runPrivateCodexProbe(raw: unknown): Promise<ProbeReport> {
  const report = { ...reportTemplate };
  let needles = [SENTINEL];
  const scan = (text: string) => observe(text, needles, report);
  try {
    const input = inputSchema.parse(raw);
    const gateway = new URL(input.gatewayUrl);
    const facade = new URL(input.facadeBase);
    // No redirects or plain-text remote endpoints may receive parent-supplied credentials.
    for (const url of [gateway, facade]) {
      const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
      if (
        (!loopback && !["wss:", "https:"].includes(url.protocol)) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        throw new Error("endpoint");
      }
    }
    if (
      !["ws:", "wss:"].includes(gateway.protocol) ||
      !["http:", "https:"].includes(facade.protocol) ||
      facade.pathname.replace(/\/$/u, "") !== "/private"
    ) {
      throw new Error("endpoint");
    }
    if (JSON.stringify(input.ownerHeaders) === JSON.stringify(input.nonownerHeaders)) {
      throw new Error("identity");
    }
    needles = [SENTINEL, ...(input.privateTarget ? [input.privateTarget] : [])];
    report.preflight_pass = 1;
    const owner = gatewayClient(input.gatewayUrl, input.ownerHeaders, scan);
    try {
      report.owner_admitted = Number((await owner.connect()) === "admitted");
    } finally {
      owner.close();
    }
    const nonowner = gatewayClient(input.gatewayUrl, input.nonownerHeaders, scan);
    try {
      report.nonowner_denied = Number((await nonowner.connect()) === "denied");
    } finally {
      nonowner.close();
    }
    if (
      !report.owner_admitted ||
      !report.nonowner_denied ||
      report.leak_hits ||
      report.explicit_model_failures
    ) {
      throw new Error("admission");
    }
    const http = async (path: string, body?: string) => {
      const response = await fetch(`${input.facadeBase.replace(/\/$/u, "")}/v1/${path}`, {
        method: body === undefined ? "GET" : "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
        headers: {
          authorization: `Bearer ${input.workloadToken}`,
          "content-type": "application/json",
        },
        body,
      });
      return { status: response.status, body: await readResponse(response, scan) };
    };
    const catalog = await http("catalog");
    const parsed = z
      .object({
        providers: z.array(
          z.object({
            models: z.array(
              z.object({ id: z.string(), displayName: z.string(), upstream: z.string() }),
            ),
          }),
        ),
      })
      .parse(JSON.parse(catalog.body));
    const rows = parsed.providers.flatMap((provider) => provider.models);
    report.facade_catalog_pass = Number(
      catalog.status === 200 &&
        rows.length === 1 &&
        rows.every(
          (row) =>
            row.id === ALIAS && row.upstream === ALIAS && row.displayName === "Codex (Latest)",
        ),
    );
    const responseRequest = {
      model: ALIAS,
      instructions: "Reply briefly.",
      input: [{ role: "user", content: [{ type: "input_text", text: "Reply OK" }] }],
      stream: true,
      store: false,
    };
    const rejected = await http(
      "responses",
      JSON.stringify({ ...responseRequest, model: SENTINEL }),
    );
    report.raw_model_rejected = Number([400, 403, 404].includes(rejected.status));
    const malformed = await http("responses", "{");
    report.malformed_request_rejected = Number([400, 422].includes(malformed.status));
    if (
      !report.facade_catalog_pass ||
      !report.raw_model_rejected ||
      !report.malformed_request_rejected ||
      report.leak_hits ||
      report.explicit_model_failures
    ) {
      throw new Error("facade");
    }
    const stream = await http("responses", JSON.stringify(responseRequest));
    report.alias_sse_pass = Number(
      stream.status === 200 &&
        stream.body.split(/\r?\n/u).some((line) => {
          if (!line.startsWith("data: ")) {
            return false;
          }
          try {
            return z
              .object({ type: z.literal("response.completed") })
              .safeParse(JSON.parse(line.slice(6))).success;
          } catch {
            return false;
          }
        }),
    );
    if (!report.alias_sse_pass || report.leak_hits || report.explicit_model_failures) {
      throw new Error("stream");
    }
    await probeHarness(input, false, scan, report);
    if (
      input.nativeSafetyContractApproved &&
      input.codexAgent &&
      !report.leak_hits &&
      !report.explicit_model_failures
    ) {
      report.native_blocked = 0;
      await probeHarness(input, true, scan, report);
    }
  } catch {
    report.errors++;
  }
  report.protocol_pass = Number(
    report.errors === 0 &&
      report.leak_hits === 0 &&
      report.explicit_model_failures === 0 &&
      report.native_blocked === 0 &&
      report.openclaw_tool_pass === 1 &&
      report.openclaw_second_turn_pass === 1 &&
      report.codex_tool_pass === 1 &&
      report.codex_second_turn_pass === 1,
  );
  try {
    scan(JSON.stringify(report));
    report.report_scanned = 1;
    if (report.leak_hits || report.explicit_model_failures) {
      report.protocol_pass = 0;
    }
  } catch {
    report.protocol_pass = 0;
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let report = { ...reportTemplate };
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "-o") {
      throw new Error("arguments");
    }
    const outputPath = z.string().min(1).parse(process.argv[3]);
    let input = "";
    const inputTimer = setTimeout(() => process.stdin.destroy(new Error("input")), 12_000);
    try {
      for await (const chunk of process.stdin) {
        input += String(chunk);
        if (Buffer.byteLength(input) > 65_536) {
          throw new Error("input");
        }
      }
    } finally {
      clearTimeout(inputTimer);
    }
    report = await runPrivateCodexProbe(JSON.parse(input));
    await writeFile(outputPath, `${JSON.stringify(report)}\n`, { flag: "wx", mode: 0o600 });
  } catch {
    report.errors++;
    report.protocol_pass = 0;
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.protocol_pass ? 0 : 1;
}
