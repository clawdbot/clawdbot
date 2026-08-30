import { Blob as NodeBlob, File as NodeFile } from "node:buffer";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, vi } from "vitest";
import * as payloadStore from "../../lib/chat/outbox-payload-store.runtime.ts";
import * as payloads from "./durable-composer-persistence.ts";

let factory: IDBFactory | undefined;

/** Node send tests exercise IDB transactions; native locks and FileReader live in E2E. */
export function installOutboxBrowserStorage(): void {
  factory = new IDBFactory();
  vi.stubGlobal("indexedDB", factory);
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("File", NodeFile);
  vi.spyOn(payloadStore, "outboxPayloadTab").mockResolvedValue("test-outbox-tab");
  vi.spyOn(payloads, "readBlobAsDataUrl").mockImplementation(
    async (blob) =>
      `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString("base64")}`,
  );
}

afterEach(async () => {
  if (!factory) {
    return;
  }
  const request = factory.deleteDatabase("openclaw-control-ui");
  await new Promise<void>((resolve, reject) => {
    request.onsuccess = () => resolve();
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("IndexedDB request failed")),
    );
  });
  factory = undefined;
});
