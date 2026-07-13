/**
 * Implements sandboxed HTTP requests for Codex native tools by routing network
 * access through the active OpenClaw sandbox backend.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { SsrFBlockedError, isBlockedHostnameOrIp } from "openclaw/plugin-sdk/ssrf-runtime";
import type { WebSocket } from "ws";
import type { JsonObject, JsonValue } from "../protocol.js";
import { readHttpHeaders, requireObject, requireString } from "./json-rpc.js";
import { ignoreChildOutputStreamErrors } from "./output-stream-errors.js";
import { requireBackend } from "./runtime.js";
import { readStreamingSandboxHttpResponse } from "./streaming-response.js";
import type { HttpHeader, OpenClawExecServer } from "./types.js";

/** Handles one sandbox HTTP JSON-RPC request, optionally streaming response body deltas. */
export async function httpRequest(
  execServer: OpenClawExecServer,
  socket: WebSocket,
  params: JsonValue | undefined,
): Promise<JsonObject> {
  const record = requireObject(params, "http/request params");
  const requestId = requireString(record.requestId, "requestId");
  const url = requireString(record.url, "url");
  assertSandboxHttpRequestTargetAllowed(url);
  const request = {
    method: requireString(record.method, "method"),
    url,
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

function assertSandboxHttpRequestTargetAllowed(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrFBlockedError("Invalid URL supplied to sandbox http/request");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrFBlockedError(
      `Blocked non-HTTP(S) protocol in sandbox http/request: ${parsed.protocol}`,
    );
  }
  if (isBlockedHostnameOrIp(parsed.hostname)) {
    throw new SsrFBlockedError(
      `Blocked hostname or private/internal IP in sandbox http/request: ${parsed.hostname}`,
    );
  }
}

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
  let child: ChildProcessWithoutNullStreams;
  try {
    const [command, ...args] = execSpec.argv;
    if (!command) {
      throw new Error("OpenClaw sandbox HTTP exec spec did not provide a command.");
    }
    child = spawn(command, args, {
      env: execSpec.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    try {
      await backend.finalizeExec?.({
        status: "failed",
        exitCode: null,
        timedOut: false,
        token: execSpec.finalizeToken,
      });
    } catch (finalizeError) {
      embeddedAgentLog.warn("codex sandbox http/request finalize after start failure failed", {
        error: finalizeError,
      });
    }
    throw error;
  }

  ignoreChildOutputStreamErrors(child);

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

const SANDBOX_HTTP_REQUEST_SCRIPT = String.raw`
tmp=$(mktemp "$TMPDIR/openclaw-http.XXXXXX.py" 2>/dev/null || mktemp "/tmp/openclaw-http.XXXXXX.py") || exit 1
trap 'rm -f "$tmp"' EXIT
cat > "$tmp" <<'PY'
import base64
import json
import ipaddress
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request

def emit(payload):
    print(json.dumps(payload, separators=(",", ":")), flush=True)

def response_headers(response):
    return [{"name": name, "value": value} for name, value in response.headers.items()]

BLOCKED_HOSTNAMES = {
    "localhost",
    "localhost.localdomain",
    "metadata.google.internal",
}
CLOUD_METADATA_IP_ADDRESSES = {
    "100.100.100.200",
    "fd00:ec2::254",
}
BLOCKED_IPV4_NETWORKS = tuple(
    ipaddress.ip_network(network)
    for network in (
        "100.64.0.0/10",
        "198.18.0.0/15",
    )
)
BLOCKED_IPV6_NETWORKS = tuple(
    ipaddress.ip_network(network)
    for network in (
        "100::/64",
        "2001:2::/48",
        "2001:20::/28",
        "2001:db8::/32",
        "fec0::/10",
    )
)
PINNED_ADDRESSES = {}

def normalize_hostname(hostname):
    return (hostname or "").strip("[]").rstrip(".").lower()

def is_blocked_hostname(hostname):
    normalized = normalize_hostname(hostname)
    return (
        normalized in BLOCKED_HOSTNAMES
        or normalized.endswith(".localhost")
        or normalized.endswith(".local")
        or normalized.endswith(".internal")
    )

def is_blocked_ip(address):
    try:
        parsed = ipaddress.ip_address(address)
    except ValueError:
        return False
    embedded_ipv4 = extract_embedded_ipv4(parsed)
    if embedded_ipv4 is not None and is_blocked_ip(str(embedded_ipv4)):
        return True
    if str(parsed).lower() in CLOUD_METADATA_IP_ADDRESSES:
        return True
    if isinstance(parsed, ipaddress.IPv4Address):
        if any(parsed in network for network in BLOCKED_IPV4_NETWORKS):
            return True
    else:
        if any(parsed in network for network in BLOCKED_IPV6_NETWORKS):
            return True
    return (
        parsed.is_loopback
        or parsed.is_private
        or parsed.is_link_local
        or parsed.is_multicast
        or parsed.is_reserved
        or parsed.is_unspecified
    )

def ipv4_from_int(value):
    return ipaddress.IPv4Address(value & 0xffffffff)

def extract_embedded_ipv4(address):
    if not isinstance(address, ipaddress.IPv6Address):
        return None
    if address.ipv4_mapped is not None:
        return address.ipv4_mapped
    value = int(address)
    hextets = [(value >> shift) & 0xffff for shift in range(112, -1, -16)]
    if hextets[:6] == [0, 0, 0, 0, 0, 0]:
        return ipv4_from_int(value)
    if hextets[:6] == [0x64, 0xff9b, 0, 0, 0, 0]:
        return ipv4_from_int(value)
    if hextets[:6] == [0x64, 0xff9b, 1, 0, 0, 0]:
        return ipv4_from_int(value)
    if hextets[0] == 0x2002:
        return ipv4_from_int((hextets[1] << 16) | hextets[2])
    if hextets[0] == 0x2001 and hextets[1] == 0:
        return ipv4_from_int(((hextets[6] << 16) | hextets[7]) ^ 0xffffffff)
    if (hextets[4] & 0xfcff) == 0 and hextets[5] == 0x5efe:
        return ipv4_from_int((hextets[6] << 16) | hextets[7])
    return None

def assert_url_allowed(url):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("http/request only supports http and https URLs")
    hostname = normalize_hostname(parsed.hostname)
    if not hostname or is_blocked_hostname(hostname) or is_blocked_ip(hostname):
        raise ValueError("Blocked hostname or private/internal/special-use IP address")
    try:
        results = socket.getaddrinfo(hostname, parsed.port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as error:
        raise ValueError(f"Unable to resolve hostname: {hostname}") from error
    addresses = {entry[4][0] for entry in results if entry[4]}
    if not addresses or any(is_blocked_ip(address) for address in addresses):
        raise ValueError("Blocked: resolves to private/internal/special-use IP address")
    PINNED_ADDRESSES[hostname] = sorted(addresses)

class GuardedRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        assert_url_allowed(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)

def pinned_getaddrinfo(original_getaddrinfo):
    def getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
        pinned = PINNED_ADDRESSES.get(normalize_hostname(host))
        if not pinned:
            return original_getaddrinfo(host, port, family, type, proto, flags)
        results = []
        for address in pinned:
            results.extend(original_getaddrinfo(address, port, family, type, proto, flags))
        return results
    return getaddrinfo

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
    assert_url_allowed(url)
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
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), GuardedRedirectHandler)
    original_getaddrinfo = socket.getaddrinfo
    socket.getaddrinfo = pinned_getaddrinfo(original_getaddrinfo)
    try:
        with opener.open(request, timeout=timeout) as response:
            handle_response(input_data, response)
    except urllib.error.HTTPError as response:
        handle_response(input_data, response)
    finally:
        socket.getaddrinfo = original_getaddrinfo

if __name__ == "__main__":
    main()
PY
python3 "$tmp"
`.trim();
