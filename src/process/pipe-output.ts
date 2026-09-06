import type { Readable, Writable } from "node:stream";

/** Keep native backpressure while leaving the caller's diagnostic destination open. */
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
    source.resume();
  };
  const onUnpipe = (stream: Readable) => {
    if (stream === source) {
      // Node's pipe error handler still needs our error listener after unpipe.
      queueMicrotask(cleanup);
    }
  };
  const onError = (error: Error) => {
    cleanup();
    reportError(error);
  };
  source.once("close", cleanup);
  destination.on("unpipe", onUnpipe);
  destination.on("error", onError);
  source.pipe(destination, { end: false });
  return cleanup;
}
