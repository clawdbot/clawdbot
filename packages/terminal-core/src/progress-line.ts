// Tracks the active terminal progress line so callers can clear it before other output.

let activeStream: NodeJS.WriteStream | null = null;

/** Register the stream that currently owns an inline progress line. */
export function registerActiveProgressLine(stream: NodeJS.WriteStream): void {
  if (!stream.isTTY) {
    return;
  }
  activeStream = stream;
}

/** Clear the active progress line when it is attached to a TTY stream. */
export function clearActiveProgressLine(): void {
  if (!activeStream?.isTTY) {
    return;
  }
  activeStream.write("\r\x1b[2K");
}

/** Unregister the active progress line, optionally only for a matching stream. */
export function unregisterActiveProgressLine(stream?: NodeJS.WriteStream): void {
  if (!activeStream) {
    return;
  }
  if (stream && activeStream !== stream) {
    return;
  }
  activeStream = null;
}
