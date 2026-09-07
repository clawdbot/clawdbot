import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { clearBootRecords, persistBootRecord, type BootRecord } from "./boot-record.ts";
import { createGatewayStoreTestStore } from "./gateway-store.test-support.ts";
import { loadSettings } from "./settings.ts";

const BOOT_RECORD_PREFIX = "openclaw.control.bootRecord.v1:";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
});

afterEach(async () => {
  clearBootRecords();
  await vi.dynamicImportSettled();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("credential changes retire boot records synchronously", () => {
  it.each([false, true])(
    "clears warm state before yielding or pagehide (persisted record: %s)",
    async (persisted) => {
      const settings = {
        ...loadSettings(),
        gatewayUrl: "ws://gateway.example.test",
        token: "test-token",
      };
      const { gateway } = createGatewayStoreTestStore({ settings });
      const record: BootRecord = {
        version: 2,
        authMethod: "token",
        credential: "9d17676d",
        scope: gatewayCredentialScope(settings.gatewayUrl),
        savedAt: Date.now(),
        profileId: "previous-profile",
        agents: {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "main" }],
        },
        groups: [{ name: "Previous profile group", position: 0 }],
        sectionOrder: ["category:Previous profile group"],
      };
      const key = BOOT_RECORD_PREFIX + record.scope;
      try {
        gateway.connect();
        if (persisted) {
          persistBootRecord(record);
          window.dispatchEvent(new Event("pagehide"));
          expect(localStorage.getItem(key)).not.toBeNull();
        }
        persistBootRecord({ ...record, sectionOrder: [] });
        gateway.connect();
        expect(localStorage.getItem(key) !== null).toBe(persisted);
        gateway.connect({ token: "replacement-token" });
        expect(gateway.connection.gatewayUrl).toBe(settings.gatewayUrl);
        expect(localStorage.getItem(key)).toBeNull();
        window.dispatchEvent(new Event("pagehide"));
        expect(localStorage.getItem(key)).toBeNull();
        await vi.advanceTimersByTimeAsync(500);
        expect(localStorage.getItem(key)).toBeNull();
      } finally {
        gateway.stop();
      }
    },
  );
});
