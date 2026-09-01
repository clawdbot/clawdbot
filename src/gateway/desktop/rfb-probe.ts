import net from "node:net";
import { Duplex } from "node:stream";

const RFB_BANNER_BYTES = 12;
const RFB_37_MINOR = 7;
const RFB_37_BANNER = Buffer.from("RFB 003.007\n", "ascii");
const RFB_38_BANNER = Buffer.from("RFB 003.008\n", "ascii");

export type RfbProbeResult =
  | { kind: "rfb"; securityTypes: number[] }
  | { kind: "not-rfb"; banner: string }
  | { kind: "unreachable" }
  | { kind: "timeout" };

type ParsedRfbVersion = {
  kind: "rfb";
  minor: number;
  reply: Buffer;
};

/** Parses the fixed-width RFB ProtocolVersion banner without socket state. */
export function parseRfbVersionBanner(
  buffer: Buffer,
): ParsedRfbVersion | { kind: "not-rfb"; banner: string } {
  const banner = buffer.subarray(0, RFB_BANNER_BYTES).toString("ascii");
  if (buffer.length < RFB_BANNER_BYTES) {
    return { kind: "not-rfb", banner };
  }
  const match = /^RFB 003\.(\d{3})\n$/u.exec(banner);
  if (!match) {
    return { kind: "not-rfb", banner };
  }
  const minor = Number.parseInt(match[1] ?? "", 10);
  return {
    kind: "rfb",
    minor,
    reply:
      minor > RFB_37_MINOR
        ? RFB_38_BANNER
        : minor === RFB_37_MINOR
          ? RFB_37_BANNER
          : Buffer.from("RFB 003.003\n", "ascii"),
  };
}

type ParsedRfbSecurity =
  | { kind: "complete"; securityTypes: number[] }
  | { kind: "incomplete"; requiredBytes: number };

/** Parses the post-version RFB security offer from a standalone buffer. */
function parseRfbSecurityTypes(buffer: Buffer, protocolMinor: number): ParsedRfbSecurity {
  if (protocolMinor < RFB_37_MINOR) {
    if (buffer.length < 4) {
      return { kind: "incomplete", requiredBytes: 4 };
    }
    const securityType = buffer.readUInt32BE(0);
    return {
      kind: "complete",
      securityTypes: securityType === 0 ? [] : [securityType],
    };
  }

  if (buffer.length < 1) {
    return { kind: "incomplete", requiredBytes: 1 };
  }
  const count = buffer.readUInt8(0);
  if (count > 0) {
    const requiredBytes = 1 + count;
    return buffer.length < requiredBytes
      ? { kind: "incomplete", requiredBytes }
      : {
          kind: "complete",
          securityTypes: [...buffer.subarray(1, requiredBytes)],
        };
  }
  return { kind: "complete", securityTypes: [] };
}

class SocketEndedError extends Error {
  constructor(readonly buffered: Buffer) {
    super("RFB server closed the handshake early");
  }
}

class SocketTimeoutError extends Error {}

function createSocketReader(socket: net.Socket) {
  let failure: Error | undefined;
  const waiters = new Set<() => void>();
  const wake = () => {
    for (const waiter of waiters) {
      waiter();
    }
    waiters.clear();
  };
  const onEnd = () => {
    failure ??= new SocketEndedError(socket.read() ?? Buffer.alloc(0));
    wake();
  };
  const onError = (error: Error) => {
    failure = error;
    wake();
  };
  // Readable mode leaves unread bytes in the socket's bounded buffer for handoff.
  socket.on("readable", wake);
  socket.once("end", onEnd);
  socket.once("close", onEnd);
  socket.once("error", onError);
  return {
    async readExactly(length: number): Promise<Buffer> {
      for (;;) {
        const value: Buffer | null = socket.read(length);
        if (value) {
          if (value.length !== length) {
            throw new SocketEndedError(value);
          }
          return value;
        }
        if (failure) {
          throw failure;
        }
        await new Promise<void>((resolve) => {
          waiters.add(resolve);
        });
      }
    },
    detach(): void {
      socket.pause();
      socket.off("readable", wake);
      socket.off("end", onEnd);
      socket.off("close", onEnd);
      socket.off("error", onError);
    },
  };
}

/** Replays the inspected prefix while keeping authentication on the same TCP connection. */
class ConnectedRfbStream extends Duplex {
  private version = Buffer.alloc(0);

  constructor(
    private readonly socket: net.Socket,
    private readonly versionReply: Buffer,
  ) {
    super({ allowHalfOpen: false });
    // The caller may still be reading credentials when the peer closes. Retain an
    // error listener through that handoff; the transport checks destroyed/errored.
    this.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      if (!this.push(chunk)) {
        socket.pause();
      }
    });
    socket.once("end", () => {
      this.push(null);
      // Stop client writes at native EOF even if the readable tail is still paused.
      this.end();
    });
    socket.once("close", () => {
      // Normal EOF may leave unread bytes in this Duplex while its consumer is paused.
      // Let them drain before auto-destroy; only a premature close discards the stream.
      if (!socket.readableEnded) {
        this.destroy(new Error("RFB peer closed before ending the stream"));
      }
    });
    socket.once("error", (error) => this.destroy(error));
  }

  override _read(): void {
    this.socket.resume();
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    let remaining = chunk;
    if (this.version.length < RFB_BANNER_BYTES) {
      const consumed = Math.min(RFB_BANNER_BYTES - this.version.length, chunk.length);
      this.version = Buffer.concat([this.version, chunk.subarray(0, consumed)]);
      remaining = chunk.subarray(consumed);
      if (this.version.length === RFB_BANNER_BYTES && !this.version.equals(this.versionReply)) {
        callback(new Error("RFB client changed the inspected protocol version"));
        return;
      }
    }
    if (remaining.length) {
      this.socket.write(remaining, callback);
    } else {
      callback();
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.socket.end(callback);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.socket.destroy();
    callback(error);
  }
}

type ConnectedRfbResult =
  | { kind: "rfb"; securityTypes: number[]; stream: Duplex }
  | Exclude<RfbProbeResult, { kind: "rfb" }>;

/** Inspects an RFB offer and retains that connection for its authenticated stream. */
export async function connectRfbServer(params: {
  host: "127.0.0.1";
  port: number;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<ConnectedRfbResult> {
  params.signal?.throwIfAborted();
  // ConnectedRfbStream alone drains and ends writes; native auto-finalization
  // would race the wrapper's queued writes when FIN arrives with unread output.
  const socket = net.createConnection({
    port: params.port,
    host: params.host,
    allowHalfOpen: true,
  });
  const deadline = setTimeout(() => {
    socket.destroy(new SocketTimeoutError("RFB handshake timed out"));
  }, params.timeoutMs);
  deadline.unref();
  const reader = createSocketReader(socket);
  let retained = false;
  const onAbort = () =>
    socket.destroy(
      params.signal?.reason instanceof Error
        ? params.signal.reason
        : new Error("RFB connection aborted"),
    );
  params.signal?.addEventListener("abort", onAbort, { once: true });
  socket.once("close", () => params.signal?.removeEventListener("abort", onAbort));
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    let bannerBytes: Buffer;
    try {
      bannerBytes = await reader.readExactly(RFB_BANNER_BYTES);
    } catch (error) {
      params.signal?.throwIfAborted();
      if (error instanceof SocketEndedError) {
        return { kind: "not-rfb", banner: error.buffered.toString("ascii") };
      }
      throw error;
    }
    const version = parseRfbVersionBanner(bannerBytes);
    if (version.kind === "not-rfb") {
      return version;
    }
    socket.write(version.reply);

    const prefixBytes = version.minor < RFB_37_MINOR ? 4 : 1;
    let securityBuffer = await reader.readExactly(prefixBytes);
    let parsed = parseRfbSecurityTypes(securityBuffer, version.minor);
    while (parsed.kind === "incomplete") {
      securityBuffer = Buffer.concat([
        securityBuffer,
        await reader.readExactly(parsed.requiredBytes - securityBuffer.length),
      ]);
      parsed = parseRfbSecurityTypes(securityBuffer, version.minor);
    }
    params.signal?.throwIfAborted();
    reader.detach();
    const stream = new ConnectedRfbStream(socket, version.reply);
    // The Gateway still receives the original RFB wire contract. Only its version
    // reply is consumed locally, since inspection already sent it to this peer.
    socket.unshift(Buffer.concat([bannerBytes, securityBuffer]));
    retained = true;
    return { kind: "rfb", securityTypes: parsed.securityTypes, stream };
  } catch (error) {
    params.signal?.throwIfAborted();
    if (error instanceof SocketTimeoutError) {
      return { kind: "timeout" };
    }
    return { kind: "unreachable" };
  } finally {
    clearTimeout(deadline);
    if (!retained) {
      reader.detach();
      socket.destroy();
    }
  }
}

/** Status-only inspection; streaming callers retain the connected result instead. */
export async function probeRfbServer(params: {
  host: "127.0.0.1";
  port: number;
  timeoutMs: number;
}): Promise<RfbProbeResult> {
  const result = await connectRfbServer(params);
  if (result.kind !== "rfb") {
    return result;
  }
  result.stream.destroy();
  return { kind: "rfb", securityTypes: result.securityTypes };
}

/** Maps standard RFB security numbers into the credential UX supported by OpenClaw. */
export function classifyRfbSecurity(
  securityTypes: readonly number[],
): "none" | "vnc-password" | "ard-account" | "unsupported" {
  // noVNC selects the first security type it supports in the server's order.
  // Mirror that choice so the Gateway credential flow cannot disagree with the
  // browser (macOS advertises ARD before its VncAuth compatibility option).
  for (const securityType of securityTypes) {
    if (securityType === 1) {
      return "none";
    }
    if (securityType === 2) {
      return "vnc-password";
    }
    if (securityType === 30) {
      return "ard-account";
    }
    if ([6, 16, 19, 22, 113].includes(securityType)) {
      // noVNC supports these schemes and stops here, but OpenClaw has no matching credential UX.
      // Scanning onward would make the probe choose a route the browser never selects.
      return "unsupported";
    }
  }
  return "unsupported";
}
