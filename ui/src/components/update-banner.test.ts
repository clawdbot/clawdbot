/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import "./update-banner.ts";

type UpdateBannerProps = {
  statusBanner: { tone: "danger" | "warn" | "info"; text: string } | null;
  action?: { label: string; onClick: () => void };
};

type UpdateBannerElement = HTMLElement & {
  props?: UpdateBannerProps;
  updateComplete: Promise<boolean>;
};

async function renderBanner(props: UpdateBannerProps): Promise<UpdateBannerElement> {
  const element = document.createElement("openclaw-update-banner") as UpdateBannerElement;
  element.props = props;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("update banner", () => {
  it("preserves status-only banners without an action", async () => {
    const element = await renderBanner({
      statusBanner: { tone: "danger", text: "Update failed" },
    });

    expect(element.querySelector(".callout")?.textContent?.trim()).toBe("Update failed");
    expect(element.querySelector(".callout")?.getAttribute("role")).toBe("alert");
    expect(element.querySelector("button")).toBeNull();
  });

  it("renders the stale Control UI refresh action", async () => {
    const onClick = vi.fn();
    const element = await renderBanner({
      statusBanner: {
        tone: "info",
        text: "Server updated — refresh for full capabilities",
      },
      action: { label: "Refresh", onClick },
    });

    expect(element.querySelector(".callout__content")?.textContent).toBe(
      "Server updated — refresh for full capabilities",
    );
    expect(element.querySelector(".callout")?.getAttribute("role")).toBe("status");
    const button = element.querySelector<HTMLButtonElement>("button");
    expect(button?.textContent?.trim()).toBe("Refresh");

    button?.click();
    expect(onClick).toHaveBeenCalledOnce();
  });
});
