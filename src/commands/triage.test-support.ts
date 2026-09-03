import { vi } from "vitest";

export function createTriageRuntime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn(), writeStdout: vi.fn(), writeJson: vi.fn() };
}

export async function withTriageTerminal(interactive: boolean, run: () => Promise<void>) {
  const streams = [process.stdin, process.stdout];
  const descriptors = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, "isTTY"));
  for (const stream of streams) {
    Object.defineProperty(stream, "isTTY", { configurable: true, value: interactive });
  }
  try {
    await run();
  } finally {
    streams.forEach((stream, index) => {
      const descriptor = descriptors[index];
      if (descriptor) {
        Object.defineProperty(stream, "isTTY", descriptor);
      } else {
        Reflect.deleteProperty(stream, "isTTY");
      }
    });
  }
}
