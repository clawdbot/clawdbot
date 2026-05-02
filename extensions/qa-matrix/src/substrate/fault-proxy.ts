import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

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

export type MatrixQaFaultProxyRule = {
  id: string;
  match(request: MatrixQaFaultProxyRequest): boolean;
  response(request: MatrixQaFaultProxyRequest): MatrixQaFaultProxyResponse;
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

async function readRequestBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
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
  req: IncomingMessage;
  targetUrl: URL;
}) {
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
      body: Buffer.from(await response.arrayBuffer()),
      headers: response.headers,
      status: response.status,
    };
  } finally {
    await release();
  }
}

function writeForwardedResponse(
  res: ServerResponse,
  response: Awaited<ReturnType<typeof forwardMatrixQaFaultProxyRequest>>,
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
  rules: MatrixQaFaultProxyRule[];
  targetBaseUrl: string;
}): Promise<MatrixQaFaultProxy> {
  const targetBaseUrl = new URL(params.targetBaseUrl);
  const hits: MatrixQaFaultProxyHit[] = [];
  const server = createServer(async (req, res) => {
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
      const body = await readRequestBody(req);
      const rule = params.rules.find((candidate) => candidate.match(request));
      if (rule) {
        hits.push({
          method: request.method,
          path: request.path,
          ruleId: rule.id,
        });
        writeJsonResponse(res, rule.response(request));
        return;
      }
      writeForwardedResponse(
        res,
        await forwardMatrixQaFaultProxyRequest({
          body,
          req,
          targetUrl: requestUrl,
        }),
      );
    } catch (error) {
      writeJsonResponse(res, {
        body: {
          errcode: "MATRIX_QA_FAULT_PROXY_ERROR",
          error: error instanceof Error ? error.message : String(error),
        },
        status: 502,
      });
    }
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
