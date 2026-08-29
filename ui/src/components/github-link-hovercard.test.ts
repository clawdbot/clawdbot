/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { i18n } from "../i18n/index.ts";
import { GitHubLinkHovercardProvider } from "./github-link-hovercard.runtime.ts";

// Mirrors CLOSE_DELAY_MS in the runtime, like the 250ms open delay used below.
const GITHUB_HOVERCARD_CLOSE_DELAY_MS = 120;

const GITHUB_LINK_HOVERCARD_ELEMENT_NAME = `test-openclaw-github-link-hovercard-provider-${crypto.randomUUID()}`;

customElements.define(
  GITHUB_LINK_HOVERCARD_ELEMENT_NAME,
  class extends GitHubLinkHovercardProvider {},
);

type GitHubLinkHovercardProviderElement = HTMLElement & {
  client: GatewayBrowserClient | null;
};

function createLink(href: string, label = "GitHub item") {
  const provider = document.createElement(
    GITHUB_LINK_HOVERCARD_ELEMENT_NAME,
  ) as GitHubLinkHovercardProviderElement;
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.textContent = label;
  provider.append(anchor);
  document.body.append(provider);
  return { anchor, provider };
}

const ISSUE_HREF = "https://github.com/openclaw/openclaw/issues/99815";

function issuePreviewResponse(overrides: Record<string, unknown> = {}) {
  return {
    comments: 2,
    createdAt: "2026-07-05T08:00:00Z",
    kind: "issue",
    login: "octocat",
    number: 99815,
    owner: "openclaw",
    repo: "openclaw",
    state: "open",
    title: "Keep hover previews reachable",
    updatedAt: "2026-07-05T09:55:00Z",
    ...overrides,
  };
}

function createIssueLink(response: Record<string, unknown> = issuePreviewResponse()) {
  const link = createLink(ISSUE_HREF, "#99815");
  link.provider.client = {
    request: vi.fn().mockResolvedValue(response),
  } as unknown as GatewayBrowserClient;
  return link;
}

function titleLinkInCard(): HTMLAnchorElement | null {
  return document.querySelector<HTMLAnchorElement>(".github-link-hovercard__title");
}

function cardLinks(): HTMLAnchorElement[] {
  return [...document.querySelectorAll<HTMLAnchorElement>(".github-link-hovercard a[href]")];
}

async function hover(anchor: HTMLAnchorElement): Promise<void> {
  anchor.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));
  await vi.advanceTimersByTimeAsync(250);
}

function leave(anchor: HTMLAnchorElement, relatedTarget: EventTarget = document.body): void {
  anchor.dispatchEvent(
    new MouseEvent("pointerout", {
      bubbles: true,
      composed: true,
      relatedTarget,
    }),
  );
}

function hovercard(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".github-link-hovercard");
}

describe("openclaw-github-link-hovercard-provider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T10:00:00Z"));
  });

  afterEach(async () => {
    await i18n.setLocale("en");
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stacks co-author faces after the author and counts the rest", async () => {
    const avatar =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlY9Z8AAAAASUVORK5CYII=";
    const request = vi.fn().mockResolvedValue({
      additions: 71,
      avatarDataUrl: avatar,
      changedFiles: 8,
      coAuthorCount: 5,
      coAuthors: [
        { login: "steipete", avatarDataUrl: avatar },
        { login: "ada", avatarDataUrl: avatar },
        { login: "mira", avatarDataUrl: avatar },
      ],
      createdAt: "2026-07-04T05:03:47Z",
      deletions: 109,
      kind: "pull",
      login: "roboclaw-bot",
      mergedAt: "2026-07-04T09:53:52Z",
      number: 131440,
      owner: "OpenClaw",
      repo: "OpenClaw",
      state: "closed",
      title: "fix(ui): open people cards from one row",
      updatedAt: "2026-07-05T09:55:00Z",
    });
    const { anchor, provider } = createLink(
      "https://github.com/openclaw/openclaw/pull/131440",
      "#131440",
    );
    provider.client = { request } as unknown as GatewayBrowserClient;

    await hover(anchor);

    const stack = document.querySelector<HTMLElement>(".github-link-hovercard__coauthors");
    expect(stack?.querySelectorAll("img")).toHaveLength(3);
    // Two co-authors beyond the three fetched faces.
    expect(stack?.querySelector(".github-link-hovercard__coauthors-more")?.textContent).toBe("+2");
    expect(stack?.getAttribute("title")).toBe("Co-authored by steipete, ada, mira");
    // The stack sits after the author, never inside the metrics.
    expect(stack?.previousElementSibling?.classList.contains("github-link-hovercard__author")).toBe(
      true,
    );
  });

  it("omits the co-author stack when a pull request has none", async () => {
    const request = vi.fn().mockResolvedValue({
      createdAt: "2026-07-04T05:03:47Z",
      kind: "pull",
      login: "roboclaw-bot",
      number: 131441,
      owner: "OpenClaw",
      repo: "OpenClaw",
      state: "open",
      title: "fix(ui): one row",
      updatedAt: "2026-07-05T09:55:00Z",
    });
    const { anchor, provider } = createLink(
      "https://github.com/openclaw/openclaw/pull/131441",
      "#131441",
    );
    provider.client = { request } as unknown as GatewayBrowserClient;

    await hover(anchor);

    expect(document.querySelector(".github-link-hovercard__coauthors")).toBeNull();
  });

  it("renders and caches pull request details without changing the link", async () => {
    const request = vi.fn().mockResolvedValue({
      additions: 101,
      avatarDataUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlY9Z8AAAAASUVORK5CYII=",
      changedFiles: 3,
      closedAt: "2026-07-04T09:53:52Z",
      createdAt: "2026-07-04T05:03:47Z",
      deletions: 12,
      draft: false,
      kind: "pull",
      login: "steipete",
      mergedAt: "2026-07-04T09:53:52Z",
      number: 99816,
      owner: "OpenClaw",
      repo: "OpenClaw",
      state: "closed",
      title: "fix(agents): derive conversation scope from trusted group facts",
      updatedAt: "2026-07-05T09:55:00Z",
    });
    const href = "https://github.com/openclaw/openclaw/pull/99816";
    const { anchor, provider } = createLink(href, "#99816");
    provider.client = { request } as unknown as GatewayBrowserClient;

    await hover(anchor);

    const card = document.querySelector<HTMLElement>(".github-link-hovercard");
    expect(card?.textContent).toContain("Merged");
    expect(card?.textContent).toContain("openclaw/openclaw #99816");
    expect(card?.textContent).toContain(
      "fix(agents): derive conversation scope from trusted group facts",
    );
    expect(card?.textContent).toContain("steipete");
    expect(card?.textContent).toContain("+101");
    expect(card?.textContent).toContain("−12");
    expect(card?.textContent).toContain("3 files");
    expect(card?.textContent).toContain("5m ago");
    expect(anchor.href).toBe(href);
    // A card that owns a link is an interactive popover, never an ARIA tooltip.
    expect(card?.getAttribute("role")).toBe("dialog");
    expect(card?.getAttribute("aria-label")).toContain(
      "fix(agents): derive conversation scope from trusted group facts",
    );
    expect(anchor.getAttribute("aria-haspopup")).toBe("dialog");
    expect(anchor.getAttribute("aria-expanded")).toBe("true");
    expect(anchor.getAttribute("aria-controls")).toBe(card?.id);
    // Title, repo reference, author and the files chip are all real links, which
    // is what makes the card a popover rather than a tooltip.
    const cardLink = (selector: string) =>
      card?.querySelector<HTMLAnchorElement>(`.github-link-hovercard__${selector}`);
    expect(cardLink("title")?.getAttribute("href")).toBe(href);
    expect(cardLink("repo")?.getAttribute("href")).toBe(href);
    expect(cardLink("author")?.getAttribute("href")).toBe("https://github.com/steipete");
    expect(cardLink("metric--files")?.getAttribute("href")).toBe(`${href}/files`);
    for (const selector of ["title", "repo", "author", "metric--files"]) {
      expect(cardLink(selector)?.target).toBe("_blank");
      expect(cardLink(selector)?.rel.split(/\s+/)).toEqual(
        expect.arrayContaining(["noopener", "noreferrer"]),
      );
    }
    expect(request).toHaveBeenCalledWith(
      "controlUi.githubPreview",
      {
        kind: "pull",
        number: 99816,
        owner: "openclaw",
        repo: "openclaw",
      },
      { signal: expect.any(AbortSignal) },
    );

    leave(anchor);
    await vi.advanceTimersByTimeAsync(GITHUB_HOVERCARD_CLOSE_DELAY_MS);
    expect(hovercard()).toBeNull();
    await hover(anchor);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("stays open while the pointer travels from the link onto the card", async () => {
    const { anchor } = createIssueLink();

    await hover(anchor);
    const card = hovercard();
    expect(card).not.toBeNull();

    // Crossing the gap between the link and the card leaves both unhovered.
    leave(anchor, card as EventTarget);
    await vi.advanceTimersByTimeAsync(GITHUB_HOVERCARD_CLOSE_DELAY_MS - 1);
    expect(hovercard()).toBe(card);

    card?.dispatchEvent(new MouseEvent("pointerenter"));
    await vi.advanceTimersByTimeAsync(GITHUB_HOVERCARD_CLOSE_DELAY_MS * 10);
    expect(hovercard()).toBe(card);

    card?.dispatchEvent(new MouseEvent("pointerleave"));
    expect(hovercard()).toBe(card);
    await vi.advanceTimersByTimeAsync(GITHUB_HOVERCARD_CLOSE_DELAY_MS);
    expect(hovercard()).toBeNull();
    expect(anchor.hasAttribute("aria-expanded")).toBe(false);
    expect(anchor.hasAttribute("aria-controls")).toBe(false);
    expect(anchor.hasAttribute("aria-haspopup")).toBe(false);
  });

  it("closes on pointer-out even after the title link inside the card was clicked", async () => {
    const { anchor } = createIssueLink();

    await hover(anchor);
    const card = hovercard();
    expect(card).not.toBeNull();

    // Pointer travels from the link onto the card, same as the traversal test above.
    leave(anchor, card as EventTarget);
    card?.dispatchEvent(new MouseEvent("pointerenter"));
    await vi.advanceTimersByTimeAsync(0);
    expect(hovercard()).toBe(card);

    // Clicking the title link focuses it (a click's real-world side effect); a
    // pointer-initiated open must still release once the pointer leaves, with no
    // click-outside required to dismiss the card.
    const titleLink = titleLinkInCard();
    titleLink?.addEventListener("click", (event) => event.preventDefault());
    titleLink?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    titleLink?.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));

    card?.dispatchEvent(new MouseEvent("pointerleave"));
    await vi.advanceTimersByTimeAsync(GITHUB_HOVERCARD_CLOSE_DELAY_MS);
    expect(hovercard()).toBeNull();
  });

  it("renders issue comments and supports focus plus Escape", async () => {
    const { anchor } = createIssueLink(issuePreviewResponse({ comments: 4 }));

    anchor.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
    await vi.advanceTimersByTimeAsync(0);

    expect(hovercard()?.textContent).toContain("4 comments");
    expect(hovercard()?.textContent).toContain("Open");
    // Issues have no files-changed view, so their metric stays plain text.
    expect(hovercard()?.querySelector(".github-link-hovercard__metric--files")).toBeNull();
    anchor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(hovercard()).toBeNull();
  });

  it("moves keyboard focus through the card's links and hands it back at the edges", async () => {
    const { anchor } = createIssueLink();

    anchor.focus();
    await vi.advanceTimersByTimeAsync(0);
    expect(hovercard()).not.toBeNull();

    // The card is portaled to document.body, so Tab has to be forwarded for any
    // of its links to be reachable at all.
    anchor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Tab" }));
    expect(document.activeElement).toBe(cardLinks()[0]);

    // Inside the run of card links Tab belongs to the browser, not to the card.
    const middle = cardLinks()[1];
    middle?.focus();
    const insideTab = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab" });
    middle?.dispatchEvent(insideTab);
    expect(insideTab.defaultPrevented).toBe(false);
    expect(hovercard()).not.toBeNull();

    // Leaving the last link returns focus to the trigger with the card closed,
    // and that returned focus must not immediately reopen what was dismissed.
    const last = cardLinks().at(-1);
    last?.focus();
    last?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Tab" }));
    expect(hovercard()).toBeNull();
    expect(document.activeElement).toBe(anchor);
    await vi.advanceTimersByTimeAsync(GITHUB_HOVERCARD_CLOSE_DELAY_MS * 2);
    expect(hovercard()).toBeNull();
  });

  it("closes on Escape from inside the card and returns focus to the link", async () => {
    const { anchor } = createIssueLink();

    anchor.focus();
    await vi.advanceTimersByTimeAsync(0);
    const title = titleLinkInCard();
    title?.focus();
    title?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));

    expect(hovercard()).toBeNull();
    expect(document.activeElement).toBe(anchor);
  });

  it("closes once focus leaves both the link and the card", async () => {
    const { anchor } = createIssueLink();
    const outside = document.createElement("button");
    document.body.append(outside);

    anchor.focus();
    await vi.advanceTimersByTimeAsync(0);
    anchor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Tab" }));
    expect(document.activeElement).toBe(cardLinks()[0]);

    outside.focus();
    await vi.advanceTimersByTimeAsync(GITHUB_HOVERCARD_CLOSE_DELAY_MS);
    expect(hovercard()).toBeNull();
    expect(anchor.hasAttribute("aria-expanded")).toBe(false);
  });

  it("ignores unsupported GitHub links and shows a quiet unavailable state", async () => {
    const request = vi.fn().mockRejectedValue(new Error("Not Found"));
    const unsupportedLink = createLink("https://github.com/openclaw/openclaw", "repository");
    unsupportedLink.provider.client = { request } as unknown as GatewayBrowserClient;

    await hover(unsupportedLink.anchor);
    expect(request).not.toHaveBeenCalled();
    expect(document.querySelector(".github-link-hovercard")).toBeNull();

    const missingLink = createLink("https://github.com/openclaw/openclaw/issues/999999", "missing");
    missingLink.provider.client = { request } as unknown as GatewayBrowserClient;
    await hover(missingLink.anchor);
    expect(document.querySelector(".github-link-hovercard")?.textContent).toContain(
      "GitHub preview unavailable",
    );
  });

  it.each([
    "http://github.com/openclaw/openclaw/issues/99815",
    "https://user:password@github.com/openclaw/openclaw/issues/99815",
    "https://example.com/openclaw/openclaw/issues/99815",
    "javascript:alert(1)",
  ])("does not preview an untrusted item URL: %s", async (href) => {
    const request = vi.fn();
    const { anchor, provider } = createLink(href);
    provider.client = { request } as unknown as GatewayBrowserClient;

    await hover(anchor);

    expect(request).not.toHaveBeenCalled();
    expect(document.querySelector(".github-link-hovercard")).toBeNull();
  });

  it("leaves no popup state on the link when hover ends before opening", async () => {
    const request = vi.fn();
    const { anchor, provider } = createLink("https://github.com/openclaw/openclaw/issues/99815");
    provider.client = { request } as unknown as GatewayBrowserClient;

    anchor.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));
    leave(anchor);
    await vi.advanceTimersByTimeAsync(250);

    expect(anchor.hasAttribute("aria-haspopup")).toBe(false);
    expect(anchor.hasAttribute("aria-expanded")).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("closes when route replacement removes its active link", async () => {
    const provider = document.createElement(
      GITHUB_LINK_HOVERCARD_ELEMENT_NAME,
    ) as GitHubLinkHovercardProviderElement;
    provider.client = {
      request: vi.fn().mockResolvedValue(issuePreviewResponse({ comments: 1 })),
    } as unknown as GatewayBrowserClient;
    const route = document.createElement("main");
    const anchor = document.createElement("a");
    anchor.href = ISSUE_HREF;
    route.append(anchor);
    provider.append(route);
    document.body.append(provider);

    await hover(anchor);
    expect(document.querySelector(".github-link-hovercard")).not.toBeNull();

    route.replaceChildren(document.createElement("p"));
    await Promise.resolve();

    expect(document.querySelector(".github-link-hovercard")).toBeNull();
    expect(anchor.hasAttribute("aria-expanded")).toBe(false);
  });

  it("rerenders an open preview when the locale changes", async () => {
    const { anchor } = createIssueLink(issuePreviewResponse({ comments: 1 }));
    await hover(anchor);

    i18n.registerTranslation("pt-BR", {
      githubPreview: {
        loading: "Carregando detalhes do GitHub…",
        unavailable: "Prévia do GitHub indisponível",
        states: {
          merged: "Mesclado",
          draft: "Rascunho",
          open: "Aberto",
          closed: "Fechado",
          notPlanned: "Não planejado",
        },
        file: "{count} arquivo",
        files: "{count} arquivos",
        comment: "{count} comentário",
        comments: "{count} comentários",
        pullRequest: "pull request",
        issue: "issue",
        ariaLabel: "{state} {kind} {repo} #{number}: {title}, por {author}",
      },
    });
    await i18n.setLocale("pt-BR");

    const card = document.querySelector<HTMLElement>(".github-link-hovercard");
    expect(card?.textContent).toContain("Aberto");
    expect(card?.textContent).toContain("1 comentário");
    expect(card?.getAttribute("aria-label")).toContain("por octocat");
  });
});
