import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCachedBootState } from "../lib/sessions/session-roster-cache.runtime.ts";
import * as snapshots from "../pages/chat/session-snapshot-invalidation.runtime.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { clearBootRecords, type BootRecord } from "./boot-record.ts";
import { bootstrapApplication } from "./bootstrap.ts";
import * as gatewayStore from "./gateway-store.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import { loadSettings, persistSessionToken } from "./settings.ts";

const BOOT_RECORD_PREFIX = "openclaw.control.bootRecord.v1:";

vi.mock("../lib/sessions/session-roster-cache.runtime.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sessions/session-roster-cache.runtime.ts")>()),
  clearCachedBootState: vi.fn(async () => undefined),
}));

describe("warm boot profile validation", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    persistSessionToken(loadSettings().gatewayUrl, "test-token");
  });
  afterEach(() => {
    clearBootRecords();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ...[
      { cachedProfileId: "profile-a", profileId: "profile-b", clears: 1 },
      { cachedProfileId: "profile-a", profileId: null, clears: 1 },
      { cachedProfileId: null, profileId: "profile-b", clears: 1 },
      { cachedProfileId: "profile-a", profileId: "profile-a", clears: 0 },
      { cachedProfileId: null, profileId: null, clears: 0 },
      { cachedProfileId: "profile-a", profileId: "profile-b", clears: 0, credentialsChanged: true },
    ].map((entry) => Object.assign(entry, { pathname: "/chat", warmBoot: true })),
    ...["/focus/terminal", "/approve/exec%3A1"].map((pathname) => ({
      cachedProfileId: "profile-a",
      profileId: "profile-b",
      clears: 0,
      pathname,
      warmBoot: false,
      credentialsChanged: false,
    })),
  ])(
    "clears $clears times for cached $cachedProfileId and connected $profileId on $pathname (credential change: $credentialsChanged)",
    async ({ cachedProfileId, profileId, clears, pathname, warmBoot, credentialsChanged }) => {
      const previousUrl = window.location.href;
      window.history.replaceState({}, "", pathname);
      const scope = gatewayCredentialScope(loadSettings().gatewayUrl);
      const record: BootRecord = {
        version: 2,
        authMethod: "token",
        credential: "9d17676d",
        scope,
        savedAt: Date.now(),
        profileId: cachedProfileId,
        agents: {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "main" }],
        },
        groups: [],
        sectionOrder: [],
      };
      localStorage.setItem(BOOT_RECORD_PREFIX + scope, JSON.stringify(record));
      const clearSnapshots = vi.spyOn(snapshots, "clearStoredChatSnapshots").mockResolvedValue();
      const clearRoster = vi.mocked(clearCachedBootState);
      const listeners = new Set<(snapshot: ApplicationGatewaySnapshot) => void>();
      let connectionRevision = 0;
      const createGateway = gatewayStore.createApplicationGateway;
      vi.spyOn(gatewayStore, "createApplicationGateway").mockImplementation((...args) => {
        const gateway = createGateway(...args);
        vi.spyOn(gateway, "connectionRevision", "get").mockImplementation(() => connectionRevision);
        vi.spyOn(gateway, "subscribe").mockImplementation((listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        });
        return gateway;
      });
      const runtime = bootstrapApplication();
      const publish = (phase: ApplicationGatewaySnapshot["phase"]) => {
        const snapshot = runtime.context.gateway.snapshot;
        Object.assign(snapshot, {
          phase,
          hello: {
            type: "hello-ok",
            protocol: 1,
            auth: { method: "token", role: "operator", scopes: [] },
          },
          selfUser: profileId === null ? null : { id: profileId },
        });
        for (const listener of listeners) {
          listener(snapshot);
        }
      };
      try {
        expect(runtime.warmBoot).toBe(warmBoot);
        if (credentialsChanged) {
          connectionRevision += 1;
        }
        publish("connecting");
        expect(clearSnapshots).not.toHaveBeenCalled();
        expect(clearRoster).not.toHaveBeenCalled();

        publish("connected");
        // Clearing the in-memory projection must precede later hello subscribers.
        expect(clearSnapshots).toHaveBeenCalledTimes(clears);
        // The persisted record gates the next boot, so it must be gone before any lazy cleanup.
        if (clears > 0) {
          expect(localStorage.getItem(BOOT_RECORD_PREFIX + scope)).toBeNull();
        } else {
          expect(localStorage.getItem(BOOT_RECORD_PREFIX + scope)).not.toBeNull();
        }
        await vi.dynamicImportSettled();
        expect(clearRoster).toHaveBeenCalledTimes(clears);

        publish("connected");
        publish("reconnecting");
        publish("connected");
        await vi.dynamicImportSettled();
        expect(clearSnapshots).toHaveBeenCalledTimes(clears);
        expect(clearRoster).toHaveBeenCalledTimes(clears);
      } finally {
        runtime.stop();
        window.history.replaceState({}, "", previousUrl);
      }
    },
  );
});
