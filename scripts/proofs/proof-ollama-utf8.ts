import { parseNdjsonStream } from "../../extensions/ollama/src/stream.runtime.js";

function readerFor(bytes: Uint8Array): ReadableStreamDefaultReader<Uint8Array> {
  let consumed = false;
  return {
    read: async () => {
      if (consumed) {
        return { done: true as const, value: undefined };
      }
      consumed = true;
      return { done: false as const, value: bytes };
    },
    releaseLock: () => {},
    cancel: async () => {},
    closed: Promise.resolve(undefined),
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

async function drain(bytes: Uint8Array): Promise<string> {
  const chunks: unknown[] = [];
  for await (const chunk of parseNdjsonStream(readerFor(bytes))) {
    chunks.push(chunk);
  }
  return JSON.stringify(chunks);
}

async function main(): Promise<void> {
  const valid = new TextEncoder().encode('{"message":{"role":"assistant","content":"hello"}}\n');
  const corrupted = new Uint8Array(valid);
  corrupted[valid.indexOf(0x68) + 1] = 0xff;

  try {
    const parsed = await drain(corrupted);
    console.log(`corrupted stream: accepted, parsed=${parsed}`);
  } catch (error) {
    console.log(`corrupted stream: rejected (${(error as Error).message})`);
  }

  console.log(`valid stream: ${await drain(valid)}`);
}

void main();
