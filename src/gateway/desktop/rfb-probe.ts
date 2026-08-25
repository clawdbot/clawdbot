import net from "node:net";

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
function parseRfbVersionBanner(
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
  | { kind: "complete"; securityTypes: number[]; bytesConsumed: number }
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
      bytesConsumed: 4,
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
          bytesConsumed: requiredBytes,
        };
  }
  return { kind: "complete", securityTypes: [], bytesConsumed: 1 };
}

class SocketEndedError extends Error {
  constructor(readonly buffered: Buffer) {
    super("RFB server closed the handshake early");
  }
}

class SocketTimeoutError extends Error {}

function createSocketReader(socket: net.Socket) {
  let buffered = Buffer.alloc(0);
  let ended = false;
  let failure: Error | undefined;
  const waiters = new Set<() => void>();
  const wake = () => {
    for (const waiter of waiters) {
      waiter();
    }
    waiters.clear();
  };
  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    wake();
  });
  socket.once("end", () => {
    ended = true;
    wake();
  });
  socket.once("error", (error) => {
    failure = error;
    wake();
  });
  socket.once("timeout", () => {
    failure = new SocketTimeoutError("RFB handshake timed out");
    wake();
  });

  return {
    async readExactly(length: number): Promise<Buffer> {
      while (buffered.length < length) {
        if (failure) {
          throw failure;
        }
        if (ended) {
          throw new SocketEndedError(buffered);
        }
        await new Promise<void>((resolve) => {
          waiters.add(resolve);
        });
      }
      const value = buffered.subarray(0, length);
      buffered = buffered.subarray(length);
      return value;
    },
  };
}

/** Connects to a loopback RFB server and reads only its version and security offer. */
export async function probeRfbServer(params: {
  host: "127.0.0.1";
  port: number;
  timeoutMs: number;
}): Promise<RfbProbeResult> {
  const socket = net.createConnection(params.port, params.host);
  const deadline = setTimeout(() => {
    socket.destroy(new SocketTimeoutError("RFB handshake timed out"));
  }, params.timeoutMs);
  deadline.unref();
  const reader = createSocketReader(socket);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    let bannerBytes: Buffer;
    try {
      bannerBytes = await reader.readExactly(RFB_BANNER_BYTES);
    } catch (error) {
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
    return { kind: "rfb", securityTypes: parsed.securityTypes };
  } catch (error) {
    if (error instanceof SocketTimeoutError) {
      return { kind: "timeout" };
    }
    return { kind: "unreachable" };
  } finally {
    clearTimeout(deadline);
    socket.end();
    socket.destroy();
  }
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
