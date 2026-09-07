import { vi } from "vitest";

export class TestScreencastSocket extends EventTarget {
  binaryType = "blob";
  readonly close = vi.fn();

  constructor(readonly url: string) {
    super();
  }

  receive(data: string | ArrayBuffer): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  disconnect(code: number, reason = ""): void {
    this.dispatchEvent(new CloseEvent("close", { code, reason }));
  }
}

export function screencastFrame(
  url = "https://example.test/page",
  width = 100,
  height = 100,
): ArrayBuffer {
  const header = new TextEncoder().encode(
    JSON.stringify({ url, cssWidth: width, cssHeight: height, scrollX: 0, scrollY: 0, ts: 1 }),
  );
  const bytes = new Uint8Array(4 + header.length + 4);
  new DataView(bytes.buffer).setUint32(0, header.length);
  bytes.set(header, 4);
  bytes.set([0xff, 0xd8, 0xff, 0xd9], 4 + header.length);
  return bytes.buffer;
}
