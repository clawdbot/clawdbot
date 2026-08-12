/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { renderCrabdex } from "./view.ts";

describe("renderCrabdex", () => {
  beforeEach(async () => {
    document.body.innerHTML = "";
    await i18n.setLocale("en");
  });

  it("renders discovered lore, first visit, hidden hints, and the count", () => {
    const firstSeenAt = new Date("2026-07-10T12:00:00.000Z").getTime();
    const entries = new Map([
      ["crimson", { firstSeenAt, name: "Ruby", shinySeenAt: firstSeenAt }] as const,
    ]);
    const container = document.createElement("div");
    render(renderCrabdex(entries), container);

    expect(container.querySelector(".crabdex-page__count")?.textContent).toBe("1/42 visited");

    const seen = container.querySelector(".crab-pet--palette-crimson")?.closest("article");
    expect(seen?.id).toBe("crabdex-crimson");
    expect(seen?.querySelector("h3")?.textContent).toBe("Ruby");
    expect(seen?.querySelector(".crabdex-page__lore")?.textContent).toBe(
      "The classic red, first in every tide pool.",
    );
    expect(seen?.querySelector(".crabdex-page__date")?.textContent).toContain(
      new Date(firstSeenAt).toLocaleDateString("en"),
    );
    expect(seen?.querySelectorAll(".crabdex-page__date")).toHaveLength(2);
    expect(seen?.querySelector(".crabdex-page__dates")?.textContent).toContain(
      `✦ Shiny spotted ${new Date(firstSeenAt).toLocaleDateString("en")}`,
    );
    expect(seen?.querySelector(".crabdex-page__star")).not.toBeNull();
    expect(seen?.querySelector('button[aria-label="Copy link"]')).not.toBeNull();

    const unseen = container.querySelector(".crab-pet--palette-watermelon")?.closest("article");
    expect(unseen?.querySelector("h3")?.textContent).toBe("?");
    expect(unseen?.querySelector(".crabdex-page__lore")?.textContent).toBe("Ripe when thumped.");
    expect(unseen?.querySelector(".crabdex-page__date")).toBeNull();
  });
});
