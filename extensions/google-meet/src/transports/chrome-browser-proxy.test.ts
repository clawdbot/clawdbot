// Google Meet tests cover chrome browser proxy plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  callBrowserProxyOnNode,
  forceMeetEnglishUi,
  isEnglishMeetTab,
} from "./chrome-browser-proxy.js";

describe("forceMeetEnglishUi", () => {
  it("pins hl=en on Meet URLs", () => {
    expect(forceMeetEnglishUi("https://meet.google.com/abc-defg-hij")).toBe(
      "https://meet.google.com/abc-defg-hij?hl=en",
    );
    expect(forceMeetEnglishUi("https://meet.google.com/new")).toBe(
      "https://meet.google.com/new?hl=en",
    );
  });

  it("overrides an existing hl and keeps other params", () => {
    expect(forceMeetEnglishUi("https://meet.google.com/abc-defg-hij?hl=zh-TW&authuser=1")).toBe(
      "https://meet.google.com/abc-defg-hij?hl=en&authuser=1",
    );
  });
});

describe("isEnglishMeetTab", () => {
  it("accepts only Meet tabs explicitly pinned to English", () => {
    expect(isEnglishMeetTab("https://meet.google.com/abc-defg-hij?hl=en")).toBe(true);
    expect(isEnglishMeetTab("https://meet.google.com/abc-defg-hij?hl=EN&authuser=1")).toBe(true);
    expect(isEnglishMeetTab("https://meet.google.com/abc-defg-hij")).toBe(false);
    expect(isEnglishMeetTab("https://meet.google.com/abc-defg-hij?hl=ja")).toBe(false);
    expect(isEnglishMeetTab("https://example.com/?hl=en")).toBe(false);
  });
});

describe("Google Meet Chrome browser proxy", () => {
  it("reports malformed node proxy payloadJSON with an owned error", async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      payloadJSON: "{not json",
    }));
    const runtime = {
      nodes: {
        invoke,
      },
    } as unknown as PluginRuntime;

    await expect(
      callBrowserProxyOnNode({
        runtime,
        nodeId: "node-1",
        method: "GET",
        path: "/tabs",
        timeoutMs: 100,
      }),
    ).rejects.toThrow("Google Meet browser proxy returned malformed payloadJSON.");

    expect(invoke).toHaveBeenCalledWith({
      nodeId: "node-1",
      command: "browser.proxy",
      params: {
        method: "GET",
        path: "/tabs",
        body: undefined,
        timeoutMs: 100,
      },
      timeoutMs: 5_100,
      scopes: ["operator.admin"],
    });
  });

  it("caps oversized node proxy gateway timeouts", async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      payloadJSON: JSON.stringify({ result: { ok: true } }),
    }));
    const runtime = {
      nodes: {
        invoke,
      },
    } as unknown as PluginRuntime;

    await callBrowserProxyOnNode({
      runtime,
      nodeId: "node-1",
      method: "GET",
      path: "/tabs",
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: MAX_TIMER_TIMEOUT_MS,
      }),
    );
  });
});
