import net from "node:net";

export type RfbAttachment =
  | { kind: "unix-socket"; socketPath: string }
  | { kind: "tcp"; host: "127.0.0.1"; port: number };

export function connectRfbAttachment(attachment: RfbAttachment): net.Socket {
  return attachment.kind === "unix-socket"
    ? net.connect(attachment.socketPath)
    : net.connect(attachment.port, attachment.host);
}
