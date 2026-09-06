import type { Readable, Writable } from "node:stream";

/** Keep native backpressure; destination loss drains diagnostics without owning its lifetime. */
export function pipeProcessOutput(
  source: Readable,
  destination: Writable,
  reportError: (error: Error) => void,
): () => void {
  const cleanup = () => {
    source.unpipe(destination);
    source.off("close", cleanup);
    destination.off("close", onDestinationEnd);
    destination.off("finish", onDestinationEnd);
    destination.off("error", onError);
  };
  const onDestinationEnd = () => {
    cleanup();
    source.resume();
  };
  const onError = (error: Error) => {
    onDestinationEnd();
    reportError(error);
  };
  source.once("close", cleanup);
  destination.once("close", onDestinationEnd);
  destination.once("finish", onDestinationEnd);
  destination.on("error", onError);
  source.pipe(destination, { end: false });
  return cleanup;
}
