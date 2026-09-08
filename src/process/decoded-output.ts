import type { Readable } from "node:stream";
import { createWindowsOutputDecoder } from "../infra/windows-encoding.js";

export function onDecodedOutput(
  stream: Readable,
  listener: (chunk: string) => void,
  onRaw?: (chunk: Buffer) => void,
): () => void {
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
  const onData = (chunk: Buffer | string) => {
    onRaw?.(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    emit(decoder.decode(chunk));
  };
  stream.on("data", onData);
  stream.once("end", flush);
  stream.once("close", flush);
  return () => {
    // A queued close may still invoke its copied listener, so suppress flush before detaching.
    flushed = true;
    stream.off("data", onData);
    stream.off("end", flush);
    stream.off("close", flush);
  };
}
