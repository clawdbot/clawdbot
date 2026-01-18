let activeStream: NodeJS.WriteStream | null = null;

export function registerActiveProgressLine(stream: NodeJS.WriteStream): void {
  if (!stream.isTTY) return;
  activeStream = stream;
}

export function clearActiveProgressLine(): void {
  if (!activeStream?.isTTY) return;
  activeStream.write("\r\x1b[2K");
}

export function unregisterActiveProgressLine(stream?: NodeJS.WriteStream): void {
  if (!activeStream) return;
  if (stream && activeStream !== stream) return;
  activeStream = null;
}
