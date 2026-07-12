// Runtime helpers for bounded subprocess log tails and service runtime lookups.
import { spawn } from "node:child_process";
import { expectDefined } from "@openclaw/normalization-core";

export { buildGatewayConnectionDetails } from "../gateway/call.js";
export { resolveGatewaySystemdServiceName } from "../daemon/constants.js";
export { readSystemdServiceRuntime } from "../daemon/systemd.js";

type ExecFileTailResult = { stdout: string; stderr: string; code: number; truncated: boolean };

type ByteTail = { chunks: Buffer[]; bytes: number; truncated: boolean };

const STDERR_MAX_BYTES = 64 * 1024;

function appendByteTail(tail: ByteTail, chunk: Buffer, maxBytes: number): void {
  tail.chunks.push(chunk);
  tail.bytes += chunk.length;
  while (tail.bytes > maxBytes && tail.chunks.length > 0) {
    const first = expectDefined(tail.chunks[0], "chunks entry at 0");
    const overflow = tail.bytes - maxBytes;
    if (first.length <= overflow) {
      tail.chunks.shift();
      tail.bytes -= first.length;
    } else {
      tail.chunks[0] = first.subarray(overflow);
      tail.bytes -= overflow;
    }
    tail.truncated = true;
  }
}

function decodeUtf8Tail(tail: ByteTail): string {
  const buffer = Buffer.concat(tail.chunks, tail.bytes);
  if (!tail.truncated || buffer.length === 0) {
    return buffer.toString("utf8");
  }
  // A byte cap can cut the leading code point. Skip only its continuation
  // bytes so decoding cannot invent a replacement character at the boundary.
  let offset = 0;
  while (
    offset < buffer.length &&
    (expectDefined(buffer[offset], "buffer entry at offset") & 0xc0) === 0x80
  ) {
    offset += 1;
  }
  return buffer.subarray(offset).toString("utf8");
}

export async function execFileUtf8Tail(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; maxBytes: number },
): Promise<ExecFileTailResult> {
  // Keep only the newest stdout bytes; log commands should not buffer unbounded output.
  return await new Promise<ExecFileTailResult>((resolve) => {
    const child = spawn(command, args, {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutTail: ByteTail = { chunks: [], bytes: 0, truncated: false };
    const stderrTail: ByteTail = { chunks: [], bytes: 0, truncated: false };
    let settled = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      appendByteTail(stdoutTail, chunk, options.maxBytes);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      appendByteTail(stderrTail, chunk, STDERR_MAX_BYTES);
    });

    const resolveWithError = (error: unknown, terminateChild = false) => {
      if (settled) {
        return;
      }
      settled = true;
      if (terminateChild) {
        // Journal output is only useful when fully readable. Stop the child so
        // a failed pipe cannot leave a live command holding the CLI open.
        child.kill();
      }
      resolve({
        stdout: decodeUtf8Tail(stdoutTail),
        stderr: error instanceof Error ? error.message : String(error),
        code: 1,
        truncated: stdoutTail.truncated,
      });
    };

    child.stdout?.on("error", (error) => resolveWithError(error, true));
    child.stderr?.on("error", (error) => resolveWithError(error, true));
    child.on("error", resolveWithError);
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        stdout: decodeUtf8Tail(stdoutTail),
        stderr: decodeUtf8Tail(stderrTail),
        code: typeof code === "number" ? code : 1,
        truncated: stdoutTail.truncated,
      });
    });
  });
}
