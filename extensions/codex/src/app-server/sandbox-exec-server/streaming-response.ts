import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { SandboxContext } from "openclaw/plugin-sdk/sandbox";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { WebSocket } from "ws";
import type { JsonObject, JsonValue } from "../protocol.js";
import { readHttpHeaders, requireNumber, requireObject, requireString } from "./json-rpc.js";
import { onChildOutputStreamError } from "./output-stream-errors.js";

const SANDBOX_HTTP_STREAM_LINE_MAX_CHARS = 256 * 1024;

export function readStreamingSandboxHttpResponse(params: {
  child: ChildProcessWithoutNullStreams;
  execSpec: { finalizeToken?: unknown };
  finalizeExec?: NonNullable<SandboxContext["backend"]>["finalizeExec"];
  requestId: string;
  socket: WebSocket;
}): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    let headerResolved = false;
    let failed = false;
    let childFailure: string | null = null;
    let streamFailure: string | null = null;
    let lastBodySeq = 0;
    let stdoutBuffer = "";
    const stdoutDecoder = new TextDecoder();
    let stderr = "";
    const stderrDecoder = new TextDecoder();
    const finalizeOnClose = async (status: "completed" | "failed", exitCode: number | null) => {
      await params.finalizeExec?.({
        status,
        exitCode,
        timedOut: false,
        token: params.execSpec.finalizeToken,
      });
    };
    const finalizeAfterClose = (status: "completed" | "failed", exitCode: number | null) => {
      void finalizeOnClose(status, exitCode).catch((error: unknown) => {
        embeddedAgentLog.warn("codex sandbox http/request finalize failed", { error });
      });
    };
    const fail = (message: string, exitCode: number | null, terminateChild = exitCode === null) => {
      if (failed) {
        return;
      }
      failed = true;
      if (headerResolved) {
        sendHttpBodyDelta(params.socket, {
          requestId: params.requestId,
          seq: lastBodySeq + 1,
          deltaBase64: "",
          done: true,
          error: message,
        });
      } else {
        reject(new Error(message));
      }
      if (terminateChild) {
        params.child.kill("SIGTERM");
      }
    };
    params.child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += stdoutDecoder.decode(chunk, { stream: true });
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
      if (stdoutBuffer.length > SANDBOX_HTTP_STREAM_LINE_MAX_CHARS) {
        params.child.kill("SIGKILL");
        fail(
          `sandbox http/request produced an unterminated stdout line longer than ${SANDBOX_HTTP_STREAM_LINE_MAX_CHARS} characters`,
          null,
          false,
        );
      }
    });
    params.child.stderr.on("data", (chunk: Buffer) => {
      stderr = sliceUtf16Safe(`${stderr}${stderrDecoder.decode(chunk, { stream: true })}`, -4096);
    });
    onChildOutputStreamError(params.child, (message) => {
      if (failed) {
        return;
      }
      failed = true;
      streamFailure = message;
      if (headerResolved) {
        sendHttpBodyDelta(params.socket, {
          requestId: params.requestId,
          seq: lastBodySeq + 1,
          deltaBase64: "",
          done: true,
          error: streamFailure,
        });
      } else {
        reject(new Error(streamFailure));
      }
      params.child.kill("SIGTERM");
    });
    params.child.once("error", (error) => {
      childFailure ??= error.message;
    });
    params.child.once("close", (code) => {
      stdoutBuffer += stdoutDecoder.decode();
      stderr = sliceUtf16Safe(`${stderr}${stderrDecoder.decode()}`, -4096);
      const exitCode = code ?? 1;
      if (streamFailure) {
        finalizeAfterClose("failed", exitCode);
        return;
      }
      if (failed) {
        finalizeAfterClose("failed", exitCode);
        return;
      }
      if (childFailure) {
        fail(childFailure, exitCode, false);
        finalizeAfterClose("failed", exitCode);
        return;
      }
      if (exitCode === 0) {
        finalizeAfterClose("completed", exitCode);
        if (!headerResolved) {
          reject(new Error("sandbox http/request exited before returning headers"));
        }
        return;
      }
      fail(stderr.trim() || `sandbox http/request failed with code ${exitCode}`, exitCode, false);
      finalizeAfterClose("failed", exitCode);
    });
  });
}

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
