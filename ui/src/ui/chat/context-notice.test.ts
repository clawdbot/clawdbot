/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../types.ts";

vi.mock("../markdown.ts", () => ({
  toSanitizedMarkdownHtml: (value: string) => value,
}));

import {
  getContextNoticeViewModel,
  renderContextNotice,
  resetContextNoticeThemeCacheForTest,
} from "./context-notice.ts";
import { renderSideResult } from "./side-result-render.ts";

describe("context notice", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetContextNoticeThemeCacheForTest();
  });

  it("renders only for fresh high current usage", () => {
    const container = document.createElement("div");
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      getPropertyValue: (name: string) =>
        name === "--warn" ? "#010203" : name === "--danger" ? "#040506" : "",
    } as CSSStyleDeclaration);
    resetContextNoticeThemeCacheForTest();

    expect(
      getContextNoticeViewModel(
        {
          key: "main",
          kind: "direct",
          updatedAt: null,
          inputTokens: 757_300,
          totalTokens: 46_000,
          contextTokens: 200_000,
        },
        200_000,
      ),
    ).toBeNull();

    const session: GatewaySessionRow = {
      key: "main",
      kind: "direct",
      updatedAt: null,
      inputTokens: 757_300,
      totalTokens: 190_000,
      contextTokens: 200_000,
    };
    render(renderContextNotice(session, 200_000), container);

    expect(container.textContent).toContain("95% context used");
    expect(container.textContent).toContain("190k / 200k");
    expect(container.textContent).not.toContain("757.3k / 200k");
    const notice = container.querySelector<HTMLElement>(".context-notice");
    expect(notice).not.toBeNull();
    expect(notice?.style.getPropertyValue("--ctx-color")).toContain("rgb(");
    expect(notice?.style.getPropertyValue("--ctx-color")).toContain("4, 5, 6");
    expect(notice?.style.getPropertyValue("--ctx-color")).not.toContain("NaN");
    expect(notice?.style.getPropertyValue("--ctx-bg")).not.toContain("NaN");

    const icon = container.querySelector<SVGElement>(".context-notice__icon");
    expect(icon).not.toBeNull();
    expect(icon?.tagName.toLowerCase()).toBe("svg");
    expect(icon?.classList.contains("context-notice__icon")).toBe(true);
    expect(icon?.getAttribute("width")).toBe("16");
    expect(icon?.getAttribute("height")).toBe("16");
    expect(icon?.querySelector("path")).not.toBeNull();

    expect(
      getContextNoticeViewModel(
        {
          key: "main",
          kind: "direct",
          updatedAt: null,
          inputTokens: 500_000,
          contextTokens: 200_000,
        },
        200_000,
      ),
    ).toBeNull();
    expect(
      getContextNoticeViewModel(
        {
          key: "main",
          kind: "direct",
          updatedAt: null,
          totalTokens: 190_000,
          totalTokensFresh: false,
          contextTokens: 200_000,
        },
        200_000,
      ),
    ).toBeNull();
  });
});

describe("side result render", () => {
  it("renders, dismisses, and styles BTW side results outside transcript history", () => {
    const container = document.createElement("div");
    const onDismissSideResult = vi.fn();

    render(
      renderSideResult(
        {
          kind: "btw",
          runId: "btw-run-1",
          sessionKey: "main",
          question: "what changed?",
          text: "The web UI now renders **BTW** separately.",
          isError: false,
          ts: 2,
        },
        onDismissSideResult,
      ),
      container,
    );

    expect(container.querySelector(".chat-side-result")).not.toBeNull();
    expect(container.textContent).toContain("BTW");
    expect(container.textContent).toContain("what changed?");
    expect(container.textContent).toContain("Not saved to chat history");
    expect(container.querySelectorAll(".chat-side-result")).toHaveLength(1);

    const button = container.querySelector<HTMLButtonElement>(".chat-side-result__dismiss");
    expect(button).not.toBeNull();
    button?.click();
    expect(onDismissSideResult).toHaveBeenCalledTimes(1);

    render(
      renderSideResult({
        kind: "btw",
        runId: "btw-run-3",
        sessionKey: "main",
        question: "what failed?",
        text: "The side question could not be answered.",
        isError: true,
        ts: 4,
      }),
      container,
    );

    expect(container.querySelector(".chat-side-result--error")).not.toBeNull();
  });
});
