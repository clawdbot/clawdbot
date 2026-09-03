import { beforeEach, describe, expect, it, vi } from "vitest";

const clientFetchMocks = vi.hoisted(() => ({
  fetchBrowserJson: vi.fn(
    async (_url: string, init?: RequestInit): Promise<Record<string, unknown>> =>
      await new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("missing agent abort signal"));
          return;
        }
        const onAbort = () =>
          reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
  ),
}));

vi.mock("./client-fetch.js", () => clientFetchMocks);

import {
  browserAct,
  browserArmDialog,
  browserArmFileChooser,
  browserNavigate,
  browserScreenshotAction,
} from "./client-actions-core.js";
import { browserConsoleMessages, browserPdfSave } from "./client-actions-observe.js";
import {
  browserCloseTab,
  browserDoctor,
  browserFocusTab,
  browserImportProfile,
  browserOpenTab,
  browserProfiles,
  browserSnapshot,
  browserStart,
  browserStatus,
  browserStop,
  browserSystemProfiles,
  browserTabs,
} from "./client.js";

describe("local browser action cancellation", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["doctor", (signal: AbortSignal) => browserDoctor(undefined, { signal })],
    ["status", (signal: AbortSignal) => browserStatus(undefined, { signal })],
    ["start", (signal: AbortSignal) => browserStart(undefined, { signal })],
    ["stop", (signal: AbortSignal) => browserStop(undefined, { signal })],
    ["profiles", (signal: AbortSignal) => browserProfiles(undefined, { signal })],
    ["system profiles", (signal: AbortSignal) => browserSystemProfiles(undefined, { signal })],
    ["import profile", (signal: AbortSignal) => browserImportProfile(undefined, { signal })],
    ["tabs", (signal: AbortSignal) => browserTabs(undefined, { signal })],
    ["open", (signal: AbortSignal) => browserOpenTab(undefined, "about:blank", { signal })],
    ["focus", (signal: AbortSignal) => browserFocusTab(undefined, "tab-1", { signal })],
    ["close", (signal: AbortSignal) => browserCloseTab(undefined, "tab-1", { signal })],
    ["snapshot", (signal: AbortSignal) => browserSnapshot(undefined, { signal })],
    [
      "navigate",
      (signal: AbortSignal) => browserNavigate(undefined, { url: "about:blank", signal }),
    ],
    ["screenshot", (signal: AbortSignal) => browserScreenshotAction(undefined, { signal })],
    ["pdf", (signal: AbortSignal) => browserPdfSave(undefined, { signal })],
    ["upload", (signal: AbortSignal) => browserArmFileChooser(undefined, { paths: ["a"], signal })],
    ["dialog", (signal: AbortSignal) => browserArmDialog(undefined, { accept: true, signal })],
    ["console", (signal: AbortSignal) => browserConsoleMessages(undefined, { signal })],
    [
      "act",
      (signal: AbortSignal) => browserAct(undefined, { kind: "click", ref: "e1" }, { signal }),
    ],
  ] as const)("promptly cancels an in-flight %s transport", async (_name, run) => {
    const controller = new AbortController();
    const reason = new Error("agent turn cancelled");
    const pending = run(controller.signal);

    await vi.waitFor(() => expect(clientFetchMocks.fetchBrowserJson).toHaveBeenCalledOnce());
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(clientFetchMocks.fetchBrowserJson.mock.calls[0]?.[1]).toMatchObject({
      signal: controller.signal,
    });
  });
});
