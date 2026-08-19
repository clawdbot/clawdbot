import net from "node:net";
import type { Duplex } from "node:stream";

export type RfbAttachment =
  | { kind: "unix-socket"; socketPath: string }
  | { kind: "tcp"; host: "127.0.0.1"; port: number };

/** One already-connected RFB transport published by a remote desktop source. */
type RfbStreamAttachment = { kind: "stream"; streamId: string };

export type DesktopRfbAttachment = RfbAttachment | RfbStreamAttachment;

export function connectRfbAttachment(attachment: RfbAttachment): net.Socket {
  return attachment.kind === "unix-socket"
    ? net.connect(attachment.socketPath)
    : net.connect(attachment.port, attachment.host);
}

export type ConnectedRfbStream = Duplex;
