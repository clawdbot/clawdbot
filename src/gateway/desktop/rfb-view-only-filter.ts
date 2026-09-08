const RFB_3_8_VERSION = Buffer.from("RFB 003.008\n", "ascii");
const MAX_PENDING_BYTES = 64 * 1024;

type RfbClientPhase = "version" | "security" | "authResponse" | "clientInit" | "messages";
const FIXED_PHASE_LENGTHS: Record<Exclude<RfbClientPhase, "messages">, number> = {
  version: RFB_3_8_VERSION.length,
  security: 1,
  authResponse: 16,
  clientInit: 1,
};

type RfbClientMessageFilterResult =
  | { forward: Buffer; error?: never }
  | { forward?: never; error: string };

/** Filters one view-only RFB client byte stream without trusting WebSocket frame boundaries. */
export function createRfbClientMessageFilter(
  options: { startPhase?: "version" | "clientInit" } = {},
) {
  let phase: RfbClientPhase = options.startPhase ?? "version";
  let pending = Buffer.alloc(0);
  let failure: string | undefined;

  const fail = (error: string): RfbClientMessageFilterResult => {
    failure = error;
    pending = Buffer.alloc(0);
    return { error };
  };

  const pendingTargetLength = (): number | string => {
    if (phase !== "messages") {
      return FIXED_PHASE_LENGTHS[phase];
    }
    if (pending.length === 0) {
      return 1;
    }
    switch (pending[0]) {
      case 0:
        return 20;
      case 2:
        return pending.length < 4 ? 4 : 4 + pending.readUInt16BE(2) * 4;
      case 3:
        return 10;
      case 4:
        return 8;
      case 5:
        // noVNC's extended pointer event sets the marker bit in the button mask
        // and appends one byte for buttons 8-15.
        return pending.length < 2 ? 2 : (pending.readUInt8(1) & 0x80) !== 0 ? 7 : 6;
      case 6:
        // noVNC marks extended clipboard payloads with a negative signed length.
        return pending.length < 8 ? 8 : 8 + Math.abs(pending.readInt32BE(4));
      case 150:
        return 10;
      case 248:
        // ClientFence's payload length byte follows its 8-byte fixed header.
        return pending.length < 9 ? 9 : 9 + pending.readUInt8(8);
      case 251:
        // SetDesktopSize has one fixed 16-byte screen record in noVNC.
        return 24;
      case 255:
        // QEMU extended key event: type, subtype, down flag, keysym, keycode.
        return 12;
      default:
        return `unsupported RFB client message type ${pending[0]}`;
    }
  };

  const routePending = (forwarded: Buffer[]): string | undefined => {
    if (phase === "version") {
      if (!pending.equals(RFB_3_8_VERSION)) {
        return "unsupported RFB protocol version";
      }
      forwarded.push(pending);
      phase = "security";
    } else if (phase === "security") {
      const securityType = pending[0];
      forwarded.push(pending);
      if (securityType === 1) {
        phase = "clientInit";
      } else if (securityType === 2) {
        phase = "authResponse";
      } else {
        return `unsupported RFB security type ${securityType}`;
      }
    } else if (phase === "authResponse") {
      forwarded.push(pending);
      phase = "clientInit";
    } else if (phase === "clientInit") {
      // A passive viewer must stay shared; exclusive ClientInit would disconnect the controller.
      pending[0] = 1;
      forwarded.push(pending);
      phase = "messages";
    } else if (
      pending[0] === 0 ||
      pending[0] === 2 ||
      pending[0] === 3 ||
      pending[0] === 150 ||
      pending[0] === 248
    ) {
      forwarded.push(pending);
    }
    pending = Buffer.alloc(0);
    return undefined;
  };

  return {
    filter(chunk: Buffer): RfbClientMessageFilterResult {
      if (failure) {
        return { error: failure };
      }
      const forwarded: Buffer[] = [];
      let offset = 0;
      while (offset < chunk.length) {
        const target = pendingTargetLength();
        if (typeof target === "string") {
          return fail(target);
        }
        if (target > MAX_PENDING_BYTES) {
          return fail("RFB client message exceeds the 64 KiB buffer limit");
        }
        const take = Math.min(target - pending.length, chunk.length - offset);
        pending = Buffer.concat([pending, chunk.subarray(offset, offset + take)]);
        offset += take;
        const completedTarget = pendingTargetLength();
        if (typeof completedTarget === "string") {
          return fail(completedTarget);
        }
        if (completedTarget > MAX_PENDING_BYTES) {
          return fail("RFB client message exceeds the 64 KiB buffer limit");
        }
        if (pending.length < completedTarget) {
          continue;
        }
        const error = routePending(forwarded);
        if (error) {
          return fail(error);
        }
      }
      return { forward: Buffer.concat(forwarded) };
    },
  };
}
