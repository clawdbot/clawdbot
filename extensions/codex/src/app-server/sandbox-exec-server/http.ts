import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { SandboxContext } from "openclaw/plugin-sdk/sandbox";
import type { WebSocket } from "ws";
import type { JsonObject, JsonValue } from "../protocol.js";
import { readHttpHeaders, requireNumber, requireObject, requireString } from "./json-rpc.js";
import { requireBackend } from "./runtime.js";
import type { HttpHeader, OpenClawExecServer } from "./types.js";

export async function httpRequest(
  execServer: OpenClawExecServer,
  socket: WebSocket,
  params: JsonValue | undefined,
): Promise<JsonObject> {
  const record = requireObject(params, "http/request params");
  const requestId = requireString(record.requestId, "requestId");
  const request = {
    method: requireString(record.method, "method"),
    url: requireString(record.url, "url"),
    headers: readHttpHeaders(record.headers),
    bodyBase64: typeof record.bodyBase64 === "string" ? record.bodyBase64 : undefined,
    timeoutMs:
      typeof record.timeoutMs === "number" && record.timeoutMs > 0
        ? Math.floor(record.timeoutMs)
        : undefined,
    streamResponse: record.streamResponse === true,
  };
  if (request.streamResponse) {
    return await runStreamingSandboxHttpRequest(execServer, socket, requestId, request);
  }
  const result = await runSandboxHttpRequest(execServer, {
    ...request,
    streamResponse: false,
  });
  return result;
}

type SandboxHttpRequest = {
  method: string;
  url: string;
  headers: HttpHeader[];
  bodyBase64?: string;
  timeoutMs?: number;
  streamResponse: boolean;
};

async function runSandboxHttpRequest(
  execServer: OpenClawExecServer,
  params: SandboxHttpRequest,
): Promise<JsonObject & { status: number; headers: HttpHeader[]; bodyBase64: string }> {
  const backend = requireBackend(execServer);
  const result = await backend.runShellCommand({
    script: SANDBOX_HTTP_REQUEST_SCRIPT,
    stdin: JSON.stringify(params),
    allowFailure: true,
  });
  if (result.code !== 0) {
    const stderr = result.stderr.toString("utf8").trim();
    throw new Error(stderr || `sandbox http/request failed with code ${result.code}`);
  }
  const parsed = JSON.parse(result.stdout.toString("utf8")) as {
    status?: unknown;
    headers?: unknown;
    bodyBase64?: unknown;
  };
  if (typeof parsed.status !== "number" || !Array.isArray(parsed.headers)) {
    throw new Error("sandbox http/request returned an invalid response envelope");
  }
  return {
    status: parsed.status,
    headers: readHttpHeaders(parsed.headers),
    bodyBase64: typeof parsed.bodyBase64 === "string" ? parsed.bodyBase64 : "",
  };
}

async function runStreamingSandboxHttpRequest(
  execServer: OpenClawExecServer,
  socket: WebSocket,
  requestId: string,
  params: SandboxHttpRequest,
): Promise<JsonObject> {
  const backend = requireBackend(execServer);
  const execSpec = await backend.buildExecSpec({
    command: SANDBOX_HTTP_REQUEST_SCRIPT,
    workdir: execServer.sandbox.containerWorkdir,
    env: {},
    usePty: false,
  });
  const [command, ...args] = execSpec.argv;
  if (!command) {
    throw new Error("OpenClaw sandbox HTTP exec spec did not provide a command.");
  }

  const child = spawn(command, args, {
    env: execSpec.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const abortOnSocketClose = () => child.kill("SIGTERM");
  socket.once("close", abortOnSocketClose);
  child.once("close", () => {
    socket.off("close", abortOnSocketClose);
  });
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") {
      return;
    }
    embeddedAgentLog.warn("codex sandbox http/request stdin write failed", { error });
  });
  child.stdin.end(JSON.stringify(params));
  return await readStreamingSandboxHttpResponse({
    child,
    execSpec,
    finalizeExec: backend.finalizeExec,
    requestId,
    socket,
  });
}

function readStreamingSandboxHttpResponse(params: {
  child: ChildProcessWithoutNullStreams;
  execSpec: { finalizeToken?: unknown };
  finalizeExec?: NonNullable<SandboxContext["backend"]>["finalizeExec"];
  requestId: string;
  socket: WebSocket;
}): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    let headerResolved = false;
    let failed = false;
    let lastBodySeq = 0;
    let stdoutBuffer = "";
    let stderr = "";
    const finalize = async (status: "completed" | "failed", exitCode: number | null) => {
      await params.finalizeExec?.({
        status,
        exitCode,
        timedOut: false,
        token: params.execSpec.finalizeToken,
      });
    };
    const fail = (message: string, exitCode: number | null) => {
      if (failed) {
        return;
      }
      failed = true;
      void finalize("failed", exitCode).catch((error: unknown) => {
        embeddedAgentLog.warn("codex sandbox http/request finalize failed", { error });
      });
      if (headerResolved) {
        sendHttpBodyDelta(params.socket, {
          requestId: params.requestId,
          seq: lastBodySeq + 1,
          deltaBase64: "",
          done: true,
          error: message,
        });
        return;
      }
      reject(new Error(message));
    };
    params.child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line) {
          try {
            const message = requireObject(JSON.parse(line) as JsonValue, "http stream message");
            const type = requireString(message.type, "http stream message type");
            if (type === "headers") {
              headerResolved = true;
              resolve({
                status: requireNumber(message.status, "http status"),
                headers: readHttpHeaders(message.headers),
                bodyBase64: "",
              });
            } else if (type === "bodyDelta") {
              const seq = requireNumber(message.seq, "http body sequence");
              lastBodySeq = Math.max(lastBodySeq, seq);
              sendHttpBodyDelta(params.socket, {
                requestId: params.requestId,
                seq,
                deltaBase64: typeof message.deltaBase64 === "string" ? message.deltaBase64 : "",
                done: message.done === true,
                error: typeof message.error === "string" ? message.error : null,
              });
            }
          } catch (error) {
            fail(error instanceof Error ? error.message : String(error), null);
          }
        }
        newline = stdoutBuffer.indexOf("\n");
      }
    });
    params.child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4096);
    });
    params.child.once("error", (error) => fail(error.message, null));
    params.child.once("close", (code) => {
      const exitCode = code ?? 1;
      if (failed) {
        return;
      }
      if (exitCode === 0) {
        void finalize("completed", exitCode).catch((error: unknown) => {
          embeddedAgentLog.warn("codex sandbox http/request finalize failed", { error });
        });
        if (!headerResolved) {
          reject(new Error("sandbox http/request exited before returning headers"));
        }
        return;
      }
      fail(stderr.trim() || `sandbox http/request failed with code ${exitCode}`, exitCode);
    });
  });
}

const SANDBOX_HTTP_REQUEST_SCRIPT = String.raw`
tmp=$(mktemp "$TMPDIR/openclaw-http.XXXXXX.py" 2>/dev/null || mktemp "/tmp/openclaw-http.XXXXXX.py") || exit 1
trap 'rm -f "$tmp"' EXIT
cat > "$tmp" <<'PY'
import base64
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

def emit(payload):
    print(json.dumps(payload, separators=(",", ":")), flush=True)

def response_headers(response):
    return [{"name": name, "value": value} for name, value in response.headers.items()]

def handle_response(input_data, response):
    headers = response_headers(response)
    status = int(getattr(response, "status", getattr(response, "code", 0)))
    if input_data.get("streamResponse"):
        emit({"type": "headers", "status": status, "headers": headers})
        seq = 1
        while True:
            chunk = response.read(65536)
            if not chunk:
                break
            emit({
                "type": "bodyDelta",
                "seq": seq,
                "deltaBase64": base64.b64encode(chunk).decode("ascii"),
                "done": False,
            })
            seq += 1
        emit({"type": "bodyDelta", "seq": seq, "deltaBase64": "", "done": True})
        return
    body = response.read()
    emit({
        "status": status,
        "headers": headers,
        "bodyBase64": base64.b64encode(body).decode("ascii"),
    })

def main():
    input_data = json.load(sys.stdin)
    url = str(input_data.get("url", ""))
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("http/request only supports http and https URLs")
    body_base64 = input_data.get("bodyBase64")
    data = base64.b64decode(body_base64) if isinstance(body_base64, str) else None
    request = urllib.request.Request(
        url,
        data=data,
        method=str(input_data.get("method", "GET")),
    )
    for header in input_data.get("headers") or []:
        request.add_header(str(header.get("name", "")), str(header.get("value", "")))
    timeout_ms = input_data.get("timeoutMs")
    timeout = None
    if isinstance(timeout_ms, (int, float)) and timeout_ms > 0:
        timeout = timeout_ms / 1000
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            handle_response(input_data, response)
    except urllib.error.HTTPError as response:
        handle_response(input_data, response)

if __name__ == "__main__":
    main()
PY
python3 "$tmp"
`.trim();

function sendHttpBodyDelta(
  socket: WebSocket,
  params: {
    requestId: string;
    seq: number;
    deltaBase64: string;
    done: boolean;
    error?: string | null;
  },
): void {
  if (socket.readyState !== 1) {
    return;
  }
  socket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "http/request/bodyDelta",
      params: {
        requestId: params.requestId,
        seq: params.seq,
        deltaBase64: params.deltaBase64,
        done: params.done,
        error: params.error ?? null,
      },
    }),
  );
}
