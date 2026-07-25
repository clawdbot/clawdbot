/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { i18n } from "../i18n/index.ts";
import { GitHubLinkHovercardProvider } from "./github-link-hovercard.ts";

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

async function hover(anchor: HTMLAnchorElement): Promise<void> {
  anchor.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));
  await vi.advanceTimersByTimeAsync(250);
}

function leave(anchor: HTMLAnchorElement): void {
  anchor.dispatchEvent(
    new MouseEvent("pointerout", {
      bubbles: true,
      composed: true,
      relatedTarget: document.body,
    }),
  );
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
    expect(anchor.getAttribute("aria-describedby")).toBe(card?.id);
    expect(request).toHaveBeenCalledWith("controlUi.githubPreview", {
      kind: "pull",
      number: 99816,
      owner: "openclaw",
      repo: "openclaw",
    });

    leave(anchor);
    expect(document.querySelector(".github-link-hovercard")).toBeNull();
    await hover(anchor);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("renders issue comments and supports focus plus Escape", async () => {
    const request = vi.fn().mockResolvedValue({
      closedAt: null,
      comments: 4,
      createdAt: "2026-07-05T08:00:00Z",
      kind: "issue",
      login: "octocat",
      number: 99815,
      owner: "openclaw",
      repo: "openclaw",
      state: "open",
      stateReason: null,
      title: "Keep hover previews compact",
      updatedAt: "2026-07-05T09:55:00Z",
    });
    const { anchor, provider } = createLink(
      "https://github.com/openclaw/openclaw/issues/99815",
      "#99815",
    );
    provider.client = { request } as unknown as GatewayBrowserClient;

    anchor.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
    await vi.advanceTimersByTimeAsync(0);

    expect(document.querySelector(".github-link-hovercard")?.textContent).toContain("4 comments");
    expect(document.querySelector(".github-link-hovercard")?.textContent).toContain("Open");
    anchor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".github-link-hovercard")).toBeNull();
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

  it("preserves an existing description when hover ends before opening", async () => {
    const request = vi.fn();
    const { anchor, provider } = createLink("https://github.com/openclaw/openclaw/issues/99815");
    provider.client = { request } as unknown as GatewayBrowserClient;
    anchor.setAttribute("aria-describedby", "existing-description");

    anchor.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));
    leave(anchor);
    await vi.advanceTimersByTimeAsync(250);

    expect(anchor.getAttribute("aria-describedby")).toBe("existing-description");
    expect(request).not.toHaveBeenCalled();
  });

  it("closes when route replacement removes its active link", async () => {
    const provider = document.createElement(
      GITHUB_LINK_HOVERCARD_ELEMENT_NAME,
    ) as GitHubLinkHovercardProviderElement;
    provider.client = {
      request: vi.fn().mockResolvedValue({
        closedAt: null,
        comments: 1,
        createdAt: "2026-07-05T08:00:00Z",
        kind: "issue",
        login: "octocat",
        number: 99815,
        owner: "openclaw",
        repo: "openclaw",
        state: "open",
        stateReason: null,
        title: "Keep hover previews compact",
        updatedAt: "2026-07-05T09:55:00Z",
      }),
    } as unknown as GatewayBrowserClient;
    const route = document.createElement("main");
    const anchor = document.createElement("a");
    anchor.href = "https://github.com/openclaw/openclaw/issues/99815";
    route.append(anchor);
    provider.append(route);
    document.body.append(provider);

    await hover(anchor);
    expect(document.querySelector(".github-link-hovercard")).not.toBeNull();

    route.replaceChildren(document.createElement("p"));
    await Promise.resolve();

    expect(document.querySelector(".github-link-hovercard")).toBeNull();
    expect(anchor.hasAttribute("aria-describedby")).toBe(false);
  });

  it("rerenders an open preview when the locale changes", async () => {
    const request = vi.fn().mockResolvedValue({
      closedAt: null,
      comments: 1,
      createdAt: "2026-07-05T08:00:00Z",
      kind: "issue",
      login: "octocat",
      number: 99815,
      owner: "openclaw",
      repo: "openclaw",
      state: "open",
      stateReason: null,
      title: "Keep hover previews compact",
      updatedAt: "2026-07-05T09:55:00Z",
    });
    const { anchor, provider } = createLink(
      "https://github.com/openclaw/openclaw/issues/99815",
      "#99815",
    );
    provider.client = { request } as unknown as GatewayBrowserClient;
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
