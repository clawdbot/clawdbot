/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { renderAbout } from "./view.ts";

type AboutProps = Parameters<typeof renderAbout>[0];

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const BUILT_AT = "2026-07-10T12:34:56.000Z";

function createProps(overrides: Partial<AboutProps> = {}): AboutProps {
  return {
    buildInfo: {
      version: "2026.7.10",
      commit: COMMIT,
      builtAt: BUILT_AT,
      branch: "feature/build-chip",
      dirty: true,
      buildId: "test",
    },
    gatewayVersion: "2026.7.9",
    copyState: "idle",
    onCopyCommit: vi.fn(),
    clawdWaving: false,
    onPokeClawd: vi.fn(),
    ...overrides,
  };
}

describe("renderAbout", () => {
  beforeEach(async () => {
    document.body.innerHTML = "";
    await i18n.setLocale("en");
  });

  it("renders the hero with Clawd, identity, community links, and license", () => {
    const onPokeClawd = vi.fn();
    const container = document.createElement("div");
    render(renderAbout(createProps({ onPokeClawd })), container);

    const hero = container.querySelector(".about-hero");
    expect(hero?.querySelector(".about-hero__name")?.textContent).toBe("OpenClaw");
    expect(hero?.querySelector(".about-hero__version")?.textContent).toBe("v2026.7.10");
    expect(hero?.querySelector(".about-hero__clawd svg")).not.toBeNull();

    const clawd = hero?.querySelector<HTMLButtonElement>(".about-hero__clawd");
    expect(clawd?.getAttribute("aria-label")).toBe("Wave hello to Clawd");
    clawd?.click();
    expect(onPokeClawd).toHaveBeenCalledOnce();

    const links = Array.from(hero?.querySelectorAll<HTMLAnchorElement>(".about-hero__link") ?? []);
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://openclaw.ai",
      "https://docs.openclaw.ai",
      "https://github.com/openclaw/openclaw",
      "https://discord.gg/clawd",
      "https://docs.openclaw.ai/releases",
    ]);
    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
      expect(link.getAttribute("rel")).toContain("noreferrer");
    }

    expect(container.querySelector(".about-footer")?.textContent).toContain("MIT License");
  });

  it("marks the hero as waving only while a poke is active", () => {
    const container = document.createElement("div");
    render(renderAbout(createProps({ clawdWaving: true })), container);
    expect(container.querySelector(".about-hero__clawd--wave")).not.toBeNull();

    render(renderAbout(createProps({ clawdWaving: false })), container);
    expect(container.querySelector(".about-hero__clawd--wave")).toBeNull();
  });

  it("keeps version, commit, branch, and localized UTC build date in one facts grid", () => {
    const container = document.createElement("div");
    render(renderAbout(createProps()), container);

    const facts = container.querySelector(".settings-kv");
    const values = facts?.querySelectorAll("dd");
    expect(facts?.getAttribute("role")).toBe("group");
    expect(facts?.getAttribute("aria-label")).toBe("Control UI build details");
    expect(values).toHaveLength(4);
    expect(values?.[0]?.textContent).toContain("2026.7.10");
    expect(values?.[1]?.querySelector("code")?.textContent).toBe(COMMIT.slice(0, 12));
    expect(values?.[1]?.querySelector("code")?.getAttribute("title")).toBe(COMMIT);
    expect(values?.[1]?.querySelector("code")?.getAttribute("dir")).toBe("ltr");

    expect(values?.[2]?.textContent).toContain("feature/build-chip*");

    const time = values?.[3]?.querySelector("time");
    expect(time?.getAttribute("datetime")).toBe(BUILT_AT);
    expect(time?.getAttribute("title")).toBe(BUILT_AT);
    expect(time?.getAttribute("dir")).toBe("auto");
    expect(time?.textContent).toBe(
      new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(
        new Date(BUILT_AT),
      ),
    );
  });

  it("keeps the connected Gateway version separate from the browser artifact", () => {
    const container = document.createElement("div");
    render(renderAbout(createProps()), container);

    expect(container.querySelector(".settings-kv")?.textContent).not.toContain("2026.7.9");
    const gatewayRow = container.querySelectorAll(".settings-row")[0];
    expect(gatewayRow?.textContent).toContain("2026.7.9");
    expect(gatewayRow?.textContent).toContain("separate from this Control UI build");
  });

  it("copies the full commit while announcing success accessibly", () => {
    const onCopyCommit = vi.fn();
    const container = document.createElement("div");
    render(renderAbout(createProps({ copyState: "copied", onCopyCommit })), container);

    const button = container.querySelector<HTMLButtonElement>(".about-commit button");
    expect(button?.getAttribute("aria-label")).toBe("Commit hash copied");
    expect(container.querySelector("[role='status']")?.textContent?.trim()).toBe(
      "Commit hash copied",
    );
    button?.click();
    expect(onCopyCommit).toHaveBeenCalledOnce();
  });

  it("states when artifact identity and Gateway version are unavailable", () => {
    const container = document.createElement("div");
    render(
      renderAbout(
        createProps({
          buildInfo: {
            version: null,
            commit: null,
            builtAt: null,
            branch: null,
            dirty: null,
            buildId: "dev",
          },
          gatewayVersion: null,
        }),
      ),
      container,
    );

    expect(container.querySelectorAll(".settings-kv .muted")).toHaveLength(3);
    expect(container.querySelector(".settings-row__value")?.textContent).toContain("Unavailable");
    expect(container.querySelector(".about-commit button")).toBeNull();
    expect(container.textContent).not.toContain("Unknown build");
  });
});
