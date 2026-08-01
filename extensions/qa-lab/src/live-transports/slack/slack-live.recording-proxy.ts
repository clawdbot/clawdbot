// QA Lab Slack proxy records native stream task chunks that Slack history does not preserve.
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { Socket } from "node:net";
import type { SlackQaNativeTaskUpdate } from "./slack-live.contracts.js";

const SLACK_QA_API_PATH_PREFIX = "/api/";
const SLACK_QA_OFFICIAL_API_URL = "https://slack.com/api/";
const SLACK_QA_TASK_TEXT_MAX_CHARS = 2_048;
const SLACK_QA_REQUEST_BODY_MAX_BYTES = 4 * 1024 * 1024;
const SLACK_QA_METHOD_PATTERN = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/u;
const SLACK_QA_STREAM_METHODS = new Set([
  "chat.appendStream",
  "chat.startStream",
  "chat.stopStream",
]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

type SlackQaRecordingProxy = {
  apiUrl: string;
  nativeTaskUpdates(): SlackQaNativeTaskUpdate[];
  stop(): Promise<void>;
};

function appendForwardHeaders(target: Headers, source: IncomingHttpHeaders) {
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        target.append(name, entry);
      }
    } else {
      target.set(name, value);
    }
  }
}

function parseNativeTaskUpdates(method: string, body: Buffer): SlackQaNativeTaskUpdate[] {
  if (!SLACK_QA_STREAM_METHODS.has(method)) {
    return [];
  }
  const chunksValue = new URLSearchParams(body.toString("utf8")).get("chunks");
  if (!chunksValue) {
    return [];
  }
  let chunks: unknown;
  try {
    chunks = JSON.parse(chunksValue) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(chunks)) {
    return [];
  }
  return chunks.flatMap((chunk) => {
    if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) {
      return [];
    }
    const record = chunk as Record<string, unknown>;
    if (record.type !== "task_update" || typeof record.id !== "string") {
      return [];
    }
    if (typeof record.title !== "string") {
      return [];
    }
    const status = typeof record.status === "string" ? record.status : undefined;
    return [
      {
        id: record.id.slice(0, SLACK_QA_TASK_TEXT_MAX_CHARS),
        method: method as SlackQaNativeTaskUpdate["method"],
        ...(status ? { status: status.slice(0, SLACK_QA_TASK_TEXT_MAX_CHARS) } : {}),
        title: record.title.slice(0, SLACK_QA_TASK_TEXT_MAX_CHARS),
      },
    ];
  });
}

async function readRequestBody(request: AsyncIterable<Buffer | string>) {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    byteLength += buffer.byteLength;
    if (byteLength > SLACK_QA_REQUEST_BODY_MAX_BYTES) {
      throw new Error("Slack QA proxy request body exceeded its limit");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function isSuccessfulSlackResponse(response: Response, body: Buffer) {
  if (!response.ok) {
    return false;
  }
  try {
    const parsed = JSON.parse(body.toString("utf8")) as unknown;
    return (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as { ok?: unknown }).ok === true
    );
  } catch {
    return false;
  }
}

export async function startSlackQaRecordingProxy(
  params: { targetApiUrl?: string } = {},
): Promise<SlackQaRecordingProxy> {
  const targetApiUrl = params.targetApiUrl ?? SLACK_QA_OFFICIAL_API_URL;
  const taskUpdates: SlackQaNativeTaskUpdate[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    void (async () => {
      const requestUrl = request.url ?? "/";
      const method = requestUrl.startsWith(SLACK_QA_API_PATH_PREFIX)
        ? requestUrl.slice(SLACK_QA_API_PATH_PREFIX.length)
        : "";
      if (request.method !== "POST" || !SLACK_QA_METHOD_PATTERN.test(method)) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid_slack_method", ok: false }));
        return;
      }
      const body = await readRequestBody(request);
      const candidateTaskUpdates = parseNativeTaskUpdates(method, body);

      const headers = new Headers();
      appendForwardHeaders(headers, request.headers);
      const upstreamAbort = new AbortController();
      request.once("aborted", () => upstreamAbort.abort());
      response.once("close", () => {
        if (!response.writableEnded) {
          upstreamAbort.abort();
        }
      });
      const upstream = await fetch(
        new URL(method, targetApiUrl.endsWith("/") ? targetApiUrl : `${targetApiUrl}/`),
        {
          body: body.byteLength > 0 ? body : undefined,
          headers,
          method: request.method,
          redirect: "manual",
          signal: upstreamAbort.signal,
        },
      );
      const upstreamBody = Buffer.from(await upstream.arrayBuffer());
      if (isSuccessfulSlackResponse(upstream, upstreamBody)) {
        taskUpdates.push(...candidateTaskUpdates);
      }
      response.statusCode = upstream.status;
      for (const [name, value] of upstream.headers) {
        const normalized = name.toLowerCase();
        if (
          !HOP_BY_HOP_HEADERS.has(normalized) &&
          normalized !== "content-encoding" &&
          normalized !== "content-length"
        ) {
          response.setHeader(name, value);
        }
      }
      response.end(upstreamBody);
    })().catch((error: unknown) => {
      if (response.destroyed) {
        return;
      }
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "application/json" });
      }
      response.end(
        JSON.stringify({
          error:
            error instanceof Error ? "slack_qa_proxy_failed" : "slack_qa_proxy_unknown_failure",
          ok: false,
        }),
      );
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Slack QA recording proxy did not bind to a TCP port");
  }
  let stopped = false;
  return {
    apiUrl: `http://127.0.0.1:${address.port}/api/`,
    nativeTaskUpdates: () => taskUpdates.slice(),
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
