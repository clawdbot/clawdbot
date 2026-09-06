import type { Readable, Writable } from "node:stream";

/** Keep native backpressure; destination loss drains diagnostics without owning its lifetime. */
export function pipeProcessOutput(
  source: Readable,
  destination: Writable,
  reportError: (error: Error) => void,
): () => void {
  const cleanup = () => {
    source.off("close", cleanup);
    destination.off("unpipe", onUnpipe);
    destination.off("error", onError);
    source.unpipe(destination);
  };
  const drain = () => {
    cleanup();
    source.resume();
  };
  const onUnpipe = (stream: Readable) => {
    if (stream === source) {
      // Node's pipe error handler still needs our error listener after unpipe.
      queueMicrotask(drain);
    }
  };
  const onError = (error: Error) => {
    drain();
    reportError(error);
  };
  source.once("close", cleanup);
  destination.on("unpipe", onUnpipe);
  destination.on("error", onError);
  source.pipe(destination, { end: false });
  return cleanup;
}
