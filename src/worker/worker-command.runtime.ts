import type { Readable, Writable } from "node:stream";
import { WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { parseWorkerLaunchDescriptor, type WorkerLaunchDescriptor } from "./launch-descriptor.js";
import { runWorkerDescriptor } from "./worker.runtime.js";

type RunWorkerCommandOptions = {
  input: Readable;
  output: Writable;
};

async function readLaunchDescriptor(input: Readable): Promise<WorkerLaunchDescriptor> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const rawChunk of input as AsyncIterable<unknown>) {
    const chunk =
      typeof rawChunk === "string"
        ? Buffer.from(rawChunk)
        : rawChunk instanceof Uint8Array
          ? Buffer.from(rawChunk)
          : undefined;
    if (!chunk) {
      throw new Error("worker launch descriptor input must be bytes");
    }
    byteLength += chunk.byteLength;
    if (byteLength > WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES) {
      throw new Error("worker launch descriptor exceeds the protocol payload limit");
    }
    chunks.push(chunk);
  }
  if (byteLength === 0) {
    throw new Error("worker launch descriptor is required on stdin");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    throw new Error("worker launch descriptor is not valid JSON", { cause: error });
  }
  return parseWorkerLaunchDescriptor(decoded);
}

/** Process shell for `openclaw worker`: stdin descriptor in, JSON result out, signals abort the run. */
export async function runWorkerCommand(options: RunWorkerCommandOptions): Promise<void> {
  const descriptor = await readLaunchDescriptor(options.input);
  const abortController = new AbortController();
  const stop = () => abortController.abort(new Error("worker interrupted"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const result = await runWorkerDescriptor(descriptor, { signal: abortController.signal });
    const encoded = `${JSON.stringify(result)}\n`;
    options.output.write(encoded);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
