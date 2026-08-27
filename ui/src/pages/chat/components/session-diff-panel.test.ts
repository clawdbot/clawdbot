/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionsDiffResult } from "../../../../../packages/gateway-protocol/src/index.js";
import {
  clearNativeGatewayTestState,
  setNativeGatewayTestState,
} from "../../../test-helpers/native-gateways.ts";
import type { SessionDiffFileTextLoader, SessionDiffLoader } from "./session-diff-panel.ts";
import "./session-diff-panel.ts";

type SessionDiffElement = HTMLElement & {
  execNode: string | null;
  loadFileText: SessionDiffFileTextLoader | null;
  loader: SessionDiffLoader | null;
  readonly updateComplete: Promise<boolean>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function result(branch: string): SessionsDiffResult {
  return {
    sessionKey: "agent:main:test",
    branch,
    baseRef: "main",
    files: [],
    additions: 0,
    deletions: 0,
  };
}

const SNAPSHOT_PATCH = [
  "--- a/example.txt",
  "+++ b/example.txt",
  "@@ -3 +3 @@",
  "-before",
  "+snapshot line",
].join("\n");

const FRESH_PATCH = [
  "--- a/example.txt",
  "+++ b/example.txt",
  "@@ -1,3 +1,3 @@",
  " fresh gap edit",
  " context",
  "-before",
  "+fresh snapshot line",
].join("\n");

function fileResult(patch: string): SessionsDiffResult {
  return {
    sessionKey: "agent:main:test",
    branch: "feature/test",
    baseRef: "main",
    files: [
      {
        path: "example.txt",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch,
      },
    ],
    additions: 1,
    deletions: 1,
  };
}

afterEach(() => {
  document.body.replaceChildren();
  clearNativeGatewayTestState();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("SessionDiffPanel", () => {
  it.each([
    { surface: "file", failed: false, feedback: "Copied!" },
    { surface: "file", failed: true, feedback: "Copy failed" },
    { surface: "sync", failed: false, feedback: "Copied!" },
    { surface: "sync", failed: true, feedback: "Copy failed" },
  ])(
    "keeps $surface path copy feedback visible: $feedback",
    async ({ surface, failed, feedback }) => {
      const writeText = failed
        ? vi.fn().mockRejectedValue(new DOMException("Clipboard access denied", "NotAllowedError"))
        : vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
      setNativeGatewayTestState(null);
      const panel = document.createElement("openclaw-session-diff") as SessionDiffElement;
      panel.loader = vi.fn(async () => ({ ...fileResult(SNAPSHOT_PATCH), root: "/workspace" }));
      document.body.append(panel);

      const triggerSelector =
        surface === "file" ? ".session-diff__file-menu" : ".session-diff__toolbar-button";
      await vi.waitFor(() => expect(panel.querySelector(triggerSelector)).not.toBeNull());
      panel.querySelector<HTMLButtonElement>(triggerSelector)?.click();
      await panel.updateComplete;

      const menu = panel.querySelector("openclaw-session-diff-menu");
      expect(menu).not.toBeNull();
      const label = surface === "file" ? "Copy Path" : "Checkout path";
      const button = menu?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
      expect(button).toBeInstanceOf(HTMLButtonElement);

      button?.click();
      await vi.waitFor(() => expect(button?.getAttribute("aria-label")).toBe(feedback));

      expect(writeText).toHaveBeenCalledWith(surface === "file" ? "example.txt" : "/workspace");
      expect(button?.dataset[failed ? "error" : "copied"]).toBe("1");
      expect(panel.querySelector("openclaw-session-diff-menu")).toBe(menu);
    },
  );

  it.each([
    { name: "plain browser", nativeGateway: null, offered: false },
    { name: "native local gateway", nativeGateway: "local", offered: true },
    { name: "native remote gateway", nativeGateway: "remote", offered: false },
    {
      name: "remote execution node",
      nativeGateway: "local",
      execNode: "build-mac",
      offered: false,
    },
  ] as const)("offers file editors only for native-local checkouts: $name", async (testCase) => {
    setNativeGatewayTestState(testCase.nativeGateway);
    const panel = document.createElement("openclaw-session-diff") as SessionDiffElement;
    panel.execNode = "execNode" in testCase ? (testCase.execNode ?? null) : null;
    panel.loader = vi.fn(async () => ({ ...fileResult(SNAPSHOT_PATCH), root: "/workspace" }));
    document.body.append(panel);

    await vi.waitFor(() => expect(panel.querySelector(".session-diff__file-menu")).not.toBeNull());
    panel.querySelector<HTMLButtonElement>(".session-diff__file-menu")?.click();
    await panel.updateComplete;

    const menu = panel.querySelector("openclaw-session-diff-menu");
    expect(menu?.textContent?.includes("Open in Editor")).toBe(testCase.offered);
    expect(menu?.textContent?.includes("Cursor")).toBe(testCase.offered);
  });

  it("closes an open editor menu when the native gateway switches to remote", async () => {
    setNativeGatewayTestState("local");
    const panel = document.createElement("openclaw-session-diff") as SessionDiffElement;
    panel.loader = vi.fn(async () => ({ ...fileResult(SNAPSHOT_PATCH), root: "/workspace" }));
    document.body.append(panel);

    await vi.waitFor(() => expect(panel.querySelector(".session-diff__file-menu")).not.toBeNull());
    panel.querySelector<HTMLButtonElement>(".session-diff__file-menu")?.click();
    await panel.updateComplete;
    expect(panel.querySelector("openclaw-session-diff-menu")?.textContent).toContain(
      "Open in Editor",
    );

    setNativeGatewayTestState("remote");
    await panel.updateComplete;

    expect(panel.querySelector("openclaw-session-diff-menu")).toBeNull();
  });

  it("commits only the latest loader result after a rapid loader change", async () => {
    const first = deferred<SessionsDiffResult>();
    const second = deferred<SessionsDiffResult>();
    const firstLoader = vi.fn(() => first.promise);
    const secondLoader = vi.fn(() => second.promise);
    const panel = document.createElement("openclaw-session-diff") as SessionDiffElement;
    panel.loader = firstLoader;
    document.body.append(panel);

    await vi.waitFor(() => expect(firstLoader).toHaveBeenCalledOnce());
    expect(firstLoader).toHaveBeenCalledWith({ scope: "all" });
    panel.loader = secondLoader;
    await vi.waitFor(() => expect(secondLoader).toHaveBeenCalledOnce());

    second.resolve(result("feature/latest"));
    await vi.waitFor(() => expect(panel.textContent).toContain("feature/latest"));
    first.resolve(result("feature/stale"));
    await panel.updateComplete;

    expect(panel.textContent).toContain("feature/latest");
    expect(panel.textContent).not.toContain("feature/stale");
  });

  it("refreshes the diff instead of expanding file text from a stale gap snapshot", async () => {
    const loader = vi
      .fn<SessionDiffLoader>()
      .mockResolvedValueOnce(fileResult(SNAPSHOT_PATCH))
      .mockResolvedValueOnce(fileResult(FRESH_PATCH));
    const loadFileText = vi
      .fn<SessionDiffFileTextLoader>()
      .mockResolvedValue(["expanded current file line", "context", "snapshot line"].join("\n"));
    const panel = document.createElement("openclaw-session-diff") as SessionDiffElement;
    panel.loader = loader;
    panel.loadFileText = loadFileText;
    document.body.append(panel);

    await vi.waitFor(() => expect(panel.querySelector(".session-diff__gap-count")).not.toBeNull());
    (panel.querySelector(".session-diff__gap-count") as HTMLButtonElement).click();

    await vi.waitFor(() => expect(panel.textContent).toContain("fresh snapshot line"));
    expect(loader).toHaveBeenCalledTimes(2);
    expect(loader).toHaveBeenNthCalledWith(2, { scope: "all" });
    expect(loadFileText).not.toHaveBeenCalled();
    expect(panel.textContent).not.toContain("expanded current file line");
    expect(panel.querySelector(".session-diff__gap-controls")).toBeNull();
  });
});
