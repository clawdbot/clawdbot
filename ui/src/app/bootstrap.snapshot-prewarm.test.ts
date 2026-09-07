import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as prewarm from "../pages/chat/session-snapshot-prewarm.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { BOOT_RECORD_PREFIX, type BootRecord } from "./boot-record.ts";
import { bootstrapApplication } from "./bootstrap.ts";
import { loadSettings, saveSettings } from "./settings.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("bootstrap routed snapshot prewarm", () => {
  it.each([
    {
      key: "agent:other:custom-main",
      boot: true,
      url: "/chat",
      expected: "agent:other:main",
    },
    {
      key: "agent:other:conversation",
      boot: true,
      url: "/chat",
      expected: "agent:other:conversation",
    },
    { key: "main", boot: true, url: "/chat", expected: null },
    { key: "agent:main:main", boot: false, url: "/chat", expected: null },
    { key: "agent:main:main", boot: true, url: "/approve/approval-1", expected: null },
    { key: "agent:main:main", boot: true, url: "/focus/terminal", expected: null },
    {
      key: "agent:main:main",
      boot: true,
      url: "/chat?gatewayUrl=ws%3A%2F%2Fanother.example",
      expected: null,
    },
  ])("prewarms $key at $url only when warm boot permits it", ({ key, boot, url, expected }) => {
    const previousUrl = window.location.href;
    vi.stubGlobal("localStorage", createStorageMock());
    const settings = { ...loadSettings(), sessionKey: key, lastActiveSessionKey: key };
    saveSettings(settings);
    const record: BootRecord = {
      version: 1,
      scope: gatewayCredentialScope(settings.gatewayUrl),
      savedAt: Date.now(),
      profileId: null,
      agents: {
        defaultId: "main",
        mainKey: "custom-main",
        scope: "per-sender",
        agents: [{ id: "main" }, { id: "other" }],
      },
      groups: [],
      sectionOrder: [],
    };
    if (boot) {
      localStorage.setItem(BOOT_RECORD_PREFIX + record.scope, JSON.stringify(record));
    }
    window.history.replaceState({}, "", url);
    const startRead = vi.spyOn(prewarm, "prewarmChatSnapshot").mockImplementation(() => undefined);
    const runtime = bootstrapApplication();
    try {
      if (expected) {
        expect(startRead).toHaveBeenCalledExactlyOnceWith(expected);
      } else {
        expect(startRead).not.toHaveBeenCalled();
      }
      expect(runtime.context.gateway.snapshot.phase).not.toBe("connected");
    } finally {
      runtime.stop();
      window.history.replaceState({}, "", previousUrl);
    }
  });
});
