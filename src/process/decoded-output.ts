import type { Readable } from "node:stream";
import { createWindowsOutputDecoder } from "../infra/windows-encoding.js";

export function onDecodedOutput(
  stream: Readable,
  listener: (chunk: string) => void,
  onRaw?: (chunk: Buffer) => void,
): void {
  const decoder = createWindowsOutputDecoder();
  const emit = (text: string) => {
    if (text) {
      listener(text);
    }
  };
  let flushed = false;
  const flush = () => {
    if (flushed) {
      return;
    }
    flushed = true;
    emit(decoder.flush());
  };
  stream.on("data", (chunk: Buffer | string) => {
    onRaw?.(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    emit(decoder.decode(chunk));
  });
  stream.once("end", flush);
  stream.once("close", flush);
}
