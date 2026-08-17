/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionsDiffResult } from "../../../../../packages/gateway-protocol/src/index.js";
import type { SessionDiffFileTextLoader, SessionDiffLoader } from "./session-diff-panel.ts";
import "./session-diff-panel.ts";

type SessionDiffElement = HTMLElement & {
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
});

describe("SessionDiffPanel", () => {
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
