import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

const DEFAULT_FAULT_PROXY_REQUEST_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_FAULT_PROXY_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

type MatrixQaFaultProxyRequest = {
  bearerToken?: string;
  headers: IncomingHttpHeaders;
  method: string;
  path: string;
  search: string;
};

type MatrixQaFaultProxyResponse = {
  body?: unknown;
  headers?: Record<string, string>;
  status: number;
};

type MatrixQaFaultProxyForwardedResponse = {
  body: Buffer;
  headers: Headers;
  status: number;
};

class MatrixQaFaultProxyHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MatrixQaFaultProxyHttpError";
  }
}

export type MatrixQaFaultProxyRule = {
  id: string;
  match(request: MatrixQaFaultProxyRequest): boolean;
  mutateResponse?(params: {
    request: MatrixQaFaultProxyRequest;
    response: MatrixQaFaultProxyForwardedResponse;
  }): MatrixQaFaultProxyForwardedResponse | Promise<MatrixQaFaultProxyForwardedResponse>;
  response?(request: MatrixQaFaultProxyRequest): MatrixQaFaultProxyResponse;
};

export type MatrixQaFaultProxyHit = {
  method: string;
  path: string;
  ruleId: string;
};

export type MatrixQaFaultProxy = {
  baseUrl: string;
  hits(): MatrixQaFaultProxyHit[];
  stop(): Promise<void>;
};

function normalizeHeaderValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  return value;
}

function extractBearerToken(headers: IncomingHttpHeaders) {
  const value = normalizeHeaderValue(headers.authorization)?.trim();
  const match = /^Bearer\s+(.+)$/i.exec(value ?? "");
  return match?.[1];
}

function buildFetchHeaders(headers: IncomingHttpHeaders) {
  const result = new Headers();
  for (const [key, rawValue] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase()) || key.toLowerCase() === "host") {
      continue;
    }
    const value = normalizeHeaderValue(rawValue);
    if (value !== undefined) {
      result.set(key, value);
    }
  }
  return result;
}

function normalizeByteChunk(chunk: string | Buffer): Buffer {
  return typeof chunk === "string" ? Buffer.from(chunk) : chunk;
}

function rejectOversizedRequestBody(maxBytes: number, size: number) {
  return new MatrixQaFaultProxyHttpError(
    413,
    "MATRIX_QA_FAULT_PROXY_REQUEST_TOO_LARGE",
    `Matrix QA fault proxy request body exceeds ${maxBytes} bytes (got at least ${size})`,
  );
}

function rejectAbortedRequestBody() {
  return new MatrixQaFaultProxyHttpError(
    400,
    "MATRIX_QA_FAULT_PROXY_REQUEST_ABORTED",
    "Matrix QA fault proxy request body ended before upload completed",
  );
}

function drainRejectedRequestBody(req: IncomingMessage) {
  const onError = () => undefined;
  const onClose = () => {
    req.off("error", onError);
  };
  req.on("error", onError);
  req.once("close", onClose);
  req.resume();
}

async function readRequestBody(req: IncomingMessage, maxBytes: number) {
  const contentLength = normalizeHeaderValue(req.headers["content-length"]);
  if (contentLength !== undefined) {
    const size = Number(contentLength);
    if (Number.isFinite(size) && size > maxBytes) {
      drainRejectedRequestBody(req);
      throw rejectOversizedRequestBody(maxBytes, size);
    }
  }

  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
      req.off("close", onClose);
    };
    const stopReading = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("aborted", onAborted);
    };
    const settleReject = (error: Error, options?: { drain?: boolean }) => {
      if (settled) {
        return;
      }
      settled = true;
      if (options?.drain) {
        stopReading();
        req.resume();
      } else {
        cleanup();
      }
      reject(error);
    };
    const onData = (chunk: string | Buffer) => {
      const buffer = normalizeByteChunk(chunk);
      const nextTotal = total + buffer.byteLength;
      if (nextTotal > maxBytes) {
        settleReject(rejectOversizedRequestBody(maxBytes, nextTotal), { drain: true });
        return;
      }
      chunks.push(buffer);
      total = nextTotal;
    };
    const onEnd = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, total));
    };
    const onError = (error: Error) => {
      if (settled) {
        cleanup();
        return;
      }
      settleReject(error);
    };
    const onAborted = () => {
      settleReject(rejectAbortedRequestBody());
    };
    const onClose = () => {
      if (settled) {
        cleanup();
        return;
      }
      if (!req.complete) {
        settleReject(rejectAbortedRequestBody());
        return;
      }
      cleanup();
    };

    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
    req.once("close", onClose);
  });
}

function bufferToArrayBuffer(buffer: Buffer) {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

function writeJsonResponse(res: ServerResponse, response: MatrixQaFaultProxyResponse) {
  const body = response.body === undefined ? "" : JSON.stringify(response.body);
  res.writeHead(response.status, {
    "content-type": "application/json",
    ...response.headers,
  });
  res.end(body);
}

async function forwardMatrixQaFaultProxyRequest(params: {
  body: Buffer;
  maxResponseBytes: number;
  req: IncomingMessage;
  targetUrl: URL;
}): Promise<MatrixQaFaultProxyForwardedResponse> {
  const method = params.req.method ?? "GET";
  const init: RequestInit = {
    headers: buildFetchHeaders(params.req.headers),
    method,
    redirect: "manual",
  };
  if (method !== "GET" && method !== "HEAD") {
    init.body = bufferToArrayBuffer(params.body);
  }
  const { response, release } = await fetchWithSsrFGuard({
    url: params.targetUrl.toString(),
    init,
    policy: { allowPrivateNetwork: true },
    auditContext: "qa-matrix-fault-proxy-forward",
  });
  try {
    return {
      body: await readResponseWithLimit(response, params.maxResponseBytes, {
        onOverflow: ({ size }) =>
          new MatrixQaFaultProxyHttpError(
            502,
            "MATRIX_QA_FAULT_PROXY_RESPONSE_TOO_LARGE",
            `Matrix QA fault proxy upstream response exceeds ${params.maxResponseBytes} bytes (got at least ${size})`,
          ),
      }),
      headers: response.headers,
      status: response.status,
    };
  } finally {
    await release();
  }
}

function writeForwardedResponse(
  res: ServerResponse,
  response: MatrixQaFaultProxyForwardedResponse,
) {
  const headers: Record<string, string> = {};
  for (const [key, value] of response.headers) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      headers[key] = value;
    }
  }
  res.writeHead(response.status, headers);
  res.end(response.body);
}

export async function startMatrixQaFaultProxy(params: {
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  rules: MatrixQaFaultProxyRule[];
  targetBaseUrl: string;
}): Promise<MatrixQaFaultProxy> {
  const targetBaseUrl = new URL(params.targetBaseUrl);
  const maxRequestBytes = params.maxRequestBytes ?? DEFAULT_FAULT_PROXY_REQUEST_MAX_BYTES;
  const maxResponseBytes = params.maxResponseBytes ?? DEFAULT_FAULT_PROXY_RESPONSE_MAX_BYTES;
  const hits: MatrixQaFaultProxyHit[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const requestUrl = new URL(req.url ?? "/", targetBaseUrl);
        const path = requestUrl.pathname;
        const bearerToken = extractBearerToken(req.headers);
        const request: MatrixQaFaultProxyRequest = {
          ...(bearerToken ? { bearerToken } : {}),
          headers: req.headers,
          method: req.method ?? "GET",
          path,
          search: requestUrl.search,
        };
        const body = await readRequestBody(req, maxRequestBytes);
        const rule = params.rules.find((candidate) => candidate.match(request));
        if (rule) {
          hits.push({
            method: request.method,
            path: request.path,
            ruleId: rule.id,
          });
          if (rule.response) {
            writeJsonResponse(res, rule.response(request));
            return;
          }
        }
        const forwarded = await forwardMatrixQaFaultProxyRequest({
          body,
          maxResponseBytes,
          req,
          targetUrl: requestUrl,
        });
        const response =
          rule?.mutateResponse !== undefined
            ? await rule.mutateResponse({
                request,
                response: forwarded,
              })
            : forwarded;
        writeForwardedResponse(res, response);
      } catch (error) {
        if (error instanceof MatrixQaFaultProxyHttpError) {
          writeJsonResponse(res, {
            body: {
              errcode: error.code,
              error: error.message,
            },
            ...(error.status === 413 ? { headers: { connection: "close" } } : {}),
            status: error.status,
          });
          return;
        }
        writeJsonResponse(res, {
          body: {
            errcode: "MATRIX_QA_FAULT_PROXY_ERROR",
            error: error instanceof Error ? error.message : String(error),
          },
          status: 502,
        });
      }
    })();
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
    throw new Error("Matrix QA fault proxy did not bind to a TCP port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    hits: () => [...hits],
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
