/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionsDiffResult } from "../../../../../packages/gateway-protocol/src/index.js";
import type { SessionDiffLoader } from "./session-diff-panel.ts";
import "./session-diff-panel.ts";

type SessionDiffElement = HTMLElement & {
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
    panel.loader = secondLoader;
    await vi.waitFor(() => expect(secondLoader).toHaveBeenCalledOnce());

    second.resolve(result("feature/latest"));
    await vi.waitFor(() => expect(panel.textContent).toContain("feature/latest"));
    first.resolve(result("feature/stale"));
    await panel.updateComplete;

    expect(panel.textContent).toContain("feature/latest");
    expect(panel.textContent).not.toContain("feature/stale");
  });
});
