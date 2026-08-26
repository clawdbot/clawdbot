#!/usr/bin/env -S node --import tsx

import { appendFileSync, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { pathToFileURL } from "node:url";

const MAX_RECORDED_BODY_BYTES = 32 * 1024;
const MAX_TRUNCATED_PREVIEW_BYTES = 8 * 1024;

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function rewriteTelegramBotApiPath(
  requestPath: string,
  aliasToken: string,
  upstreamToken: string,
): string | undefined {
  const alias = escapeRegExp(aliasToken);
  const methodMatch = new RegExp(`^/bot${alias}/([A-Za-z][A-Za-z0-9_]{0,63})(\\?.*)?$`, "u").exec(
    requestPath,
  );
  if (methodMatch) {
    return `/bot${upstreamToken}/${methodMatch[1]}${methodMatch[2] ?? ""}`;
  }
  const fileMatch = new RegExp(`^/file/bot${alias}/([^?#]+)(\\?.*)?$`, "u").exec(requestPath);
  const filePath = fileMatch?.[1];
  if (filePath && !filePath.split("/").includes("..")) {
    return `/file/bot${upstreamToken}/${filePath}${fileMatch[2] ?? ""}`;
  }
  return undefined;
}

function forwardedHeaders(headers: IncomingMessage["headers"]): http.OutgoingHttpHeaders {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name, value]) => value !== undefined && !hopByHopHeaders.has(name),
    ),
  );
}

type FaultRule = {
  method: string;
  mode?: "drop";
  status?: number;
  times?: number;
};

type FaultControlState = {
  remaining: number[];
  rules: FaultRule[];
  version: string;
};

type RequestBodyCapture = {
  contentType?: string;
  requestBody?: unknown;
};

function botApiMethod(requestPath: string, aliasToken: string): string | undefined {
  const match = new RegExp(
    `^/bot${escapeRegExp(aliasToken)}/([A-Za-z][A-Za-z0-9_]{0,63})(?:\\?.*)?$`,
    "u",
  ).exec(requestPath);
  return match?.[1];
}

function parseFaultRules(value: unknown): FaultRule[] {
  if (!value || typeof value !== "object" || !("rules" in value) || !Array.isArray(value.rules)) {
    throw new Error("Telegram proxy control rules are invalid");
  }
  return value.rules.map((rawRule) => {
    if (!rawRule || typeof rawRule !== "object" || Array.isArray(rawRule)) {
      throw new Error("Telegram proxy fault rule is invalid");
    }
    const method = "method" in rawRule ? rawRule.method : undefined;
    const times = "times" in rawRule ? rawRule.times : undefined;
    const status = "status" in rawRule ? rawRule.status : undefined;
    const mode = "mode" in rawRule ? rawRule.mode : undefined;
    if (typeof method !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(method)) {
      throw new Error("Telegram proxy fault rule method is invalid");
    }
    if (times !== undefined && (!Number.isInteger(times) || Number(times) < 1)) {
      throw new Error("Telegram proxy fault rule times is invalid");
    }
    if (
      status !== undefined &&
      (!Number.isInteger(status) || Number(status) < 400 || Number(status) > 599)
    ) {
      throw new Error("Telegram proxy fault rule status is invalid");
    }
    if (mode !== undefined && mode !== "drop") {
      throw new Error("Telegram proxy fault rule mode is invalid");
    }
    if (mode === "drop" && status !== undefined) {
      throw new Error("Telegram proxy fault rule cannot combine status and drop");
    }
    return {
      method,
      ...(times === undefined ? {} : { times: Number(times) }),
      ...(status === undefined ? {} : { status: Number(status) }),
      ...(mode === undefined ? {} : { mode }),
    };
  });
}

function readControlFile(file: string): { text: string; version: string } {
  const descriptor = openSync(file, "r");
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    return {
      text: readFileSync(descriptor, "utf8"),
      version: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`,
    };
  } finally {
    closeSync(descriptor);
  }
}

function matchingFaultRule(
  controlFile: string,
  method: string,
  state: { current?: FaultControlState },
): FaultRule | undefined {
  // Atomic lane writes replace the inode. Read and version one descriptor so a
  // replacement cannot pair new rules with an old finite-use counter.
  const { text, version } = readControlFile(controlFile);
  if (state.current?.version !== version) {
    const rules = parseFaultRules(JSON.parse(text));
    state.current = {
      remaining: rules.map((rule) => rule.times ?? -1),
      rules,
      version,
    };
  }
  const current = state.current;
  for (let index = 0; index < current.rules.length; index += 1) {
    const remaining = current.remaining[index];
    if (current.rules[index]?.method !== method || remaining === undefined || remaining === 0) {
      continue;
    }
    if (remaining !== -1) {
      current.remaining[index] = remaining - 1;
    }
    return current.rules[index];
  }
  return undefined;
}

function boundedBodyMarker(buffer: Buffer, byteLength: number, reason: string): unknown {
  return {
    __mantisTruncated: true,
    byteLength,
    preview: buffer.subarray(0, MAX_TRUNCATED_PREVIEW_BYTES).toString("utf8"),
    reason,
  };
}

function captureRequestBody(request: IncomingMessage): Promise<RequestBodyCapture> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  const multipart = contentType === "multipart/form-data";
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let capturedBytes = 0;
    let byteLength = 0;
    const finish = () => {
      if (multipart) {
        resolve({ contentType: request.headers["content-type"] });
        return;
      }
      const buffer = Buffer.concat(chunks, capturedBytes);
      if (byteLength > MAX_RECORDED_BODY_BYTES) {
        resolve({ requestBody: boundedBodyMarker(buffer, byteLength, "body exceeds 32 KiB") });
        return;
      }
      if (buffer.length === 0) {
        resolve({ requestBody: null });
        return;
      }
      try {
        const parsed = JSON.parse(buffer.toString("utf8"));
        if (Buffer.byteLength(JSON.stringify(parsed)) > MAX_RECORDED_BODY_BYTES) {
          resolve({
            requestBody: boundedBodyMarker(buffer, byteLength, "parsed JSON exceeds 32 KiB"),
          });
          return;
        }
        resolve({ requestBody: parsed });
      } catch {
        resolve({ requestBody: boundedBodyMarker(buffer, byteLength, "body is not JSON") });
      }
    };
    let finished = false;
    const finishOnce = () => {
      if (!finished) {
        finished = true;
        finish();
      }
    };
    request.on("data", (chunk: Buffer) => {
      byteLength += chunk.length;
      if (!multipart && capturedBytes < MAX_RECORDED_BODY_BYTES) {
        const captured = chunk.subarray(0, MAX_RECORDED_BODY_BYTES - capturedBytes);
        chunks.push(captured);
        capturedBytes += captured.length;
      }
    });
    request.once("end", finishOnce);
    request.once("aborted", finishOnce);
    request.once("error", finishOnce);
  });
}

function appendRecord(recordFile: string | undefined, entry: Record<string, unknown>): void {
  if (recordFile) {
    appendFileSync(recordFile, `${JSON.stringify(entry)}\n`);
  }
}

export function createTelegramBotApiProxy(params: {
  aliasToken: string;
  controlFile?: string;
  recordFile?: string;
  upstreamOrigin?: URL;
  upstreamToken: string;
}): http.Server {
  const upstreamOrigin = params.upstreamOrigin ?? new URL("https://api.telegram.org");
  const transport = upstreamOrigin.protocol === "https:" ? https : http;
  const faultState: { current?: FaultControlState } = {};
  return http.createServer((request: IncomingMessage, response: ServerResponse) => {
    const upstreamPath = rewriteTelegramBotApiPath(
      request.url ?? "",
      params.aliasToken,
      params.upstreamToken,
    );
    if (!upstreamPath) {
      response.writeHead(404).end();
      return;
    }
    const method = botApiMethod(request.url ?? "", params.aliasToken);
    const startedAt = Date.now();
    let injectedRule: FaultRule | undefined;
    try {
      injectedRule =
        method && params.controlFile
          ? matchingFaultRule(params.controlFile, method, faultState)
          : undefined;
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, description: "mantis proxy control invalid" }));
      console.error(error);
      return;
    }
    const bodyCapture =
      method && (params.recordFile || injectedRule)
        ? captureRequestBody(request)
        : Promise.resolve({});
    if (method && injectedRule) {
      void bodyCapture.then((body) => {
        const status = injectedRule.mode === "drop" ? null : (injectedRule.status ?? 500);
        try {
          appendRecord(params.recordFile, {
            at: new Date().toISOString(),
            method,
            status,
            ok: false,
            injected: true,
            durationMs: Date.now() - startedAt,
            ...body,
          });
        } catch (error) {
          console.error(error);
          request.socket.destroy(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (injectedRule.mode === "drop") {
          request.socket.destroy();
          return;
        }
        response.writeHead(status ?? 500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: false,
            error_code: status ?? 500,
            description: "mantis injected fault",
          }),
        );
      });
      return;
    }
    let recorded = false;
    const record = async (status: number) => {
      if (!method || recorded) {
        return;
      }
      recorded = true;
      appendRecord(params.recordFile, {
        at: new Date().toISOString(),
        method,
        status,
        ok: status >= 200 && status < 300,
        injected: false,
        durationMs: Date.now() - startedAt,
        ...(await bodyCapture),
      });
    };
    const upstream = transport.request(
      {
        headers: { ...forwardedHeaders(request.headers), host: upstreamOrigin.host },
        hostname: upstreamOrigin.hostname,
        method: request.method,
        path: upstreamPath,
        port: upstreamOrigin.port || undefined,
        protocol: upstreamOrigin.protocol,
      },
      (upstreamResponse) => {
        const status = upstreamResponse.statusCode ?? 502;
        response.writeHead(status, forwardedHeaders(upstreamResponse.headers));
        upstreamResponse.once("end", () => {
          void record(status).catch((error: unknown) => {
            console.error(error);
            response.destroy(error instanceof Error ? error : new Error(String(error)));
          });
        });
        upstreamResponse.pipe(response);
      },
    );
    upstream.setTimeout(90_000, () => upstream.destroy(new Error("Telegram Bot API timed out")));
    upstream.on("error", () => {
      void record(502).catch((error: unknown) => console.error(error));
      if (!response.headersSent) {
        response.writeHead(502);
      }
      response.end();
    });
    request.pipe(upstream);
  });
}

function main(): void {
  const server = createTelegramBotApiProxy({
    aliasToken: requiredEnv("TELEGRAM_PROXY_ALIAS_TOKEN"),
    controlFile: process.env.TELEGRAM_PROXY_CONTROL?.trim() || undefined,
    recordFile: process.env.TELEGRAM_PROXY_RECORD_FILE?.trim() || undefined,
    upstreamToken: requiredEnv("TELEGRAM_PROXY_UPSTREAM_TOKEN"),
  });
  server.listen(8080, "0.0.0.0", () => console.log("Telegram Bot API proxy listening"));
  const close = () => server.close();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
