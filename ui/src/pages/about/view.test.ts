/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { formatControlUiBuildDate, renderAbout, type AboutProps } from "./view.ts";

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
    ...overrides,
  };
}

describe("renderAbout", () => {
  beforeEach(async () => {
    document.body.innerHTML = "";
    await i18n.setLocale("en");
  });

  it("keeps version, commit, branch, and localized UTC build date in one definition strip", () => {
    const container = document.createElement("div");
    render(renderAbout(createProps()), container);

    const strip = container.querySelector(".about-build-strip");
    const items = strip?.querySelectorAll(":scope > div");
    expect(strip?.getAttribute("role")).toBe("group");
    expect(strip?.getAttribute("aria-label")).toBe("Control UI build details");
    expect(items).toHaveLength(4);
    expect(items?.[0]?.textContent).toContain("2026.7.10");
    expect(items?.[1]?.querySelector("code")?.textContent).toBe(COMMIT.slice(0, 12));
    expect(items?.[1]?.querySelector("code")?.getAttribute("title")).toBe(COMMIT);
    expect(items?.[1]?.querySelector("code")?.getAttribute("dir")).toBe("ltr");

    expect(items?.[2]?.textContent).toContain("feature/build-chip*");

    const time = items?.[3]?.querySelector("time");
    expect(time?.getAttribute("datetime")).toBe(BUILT_AT);
    expect(time?.getAttribute("title")).toBe(BUILT_AT);
    expect(time?.getAttribute("dir")).toBe("auto");
    expect(time?.textContent).toBe(formatControlUiBuildDate(BUILT_AT, "en"));
  });

  it("keeps the connected Gateway version separate from the browser artifact", () => {
    const container = document.createElement("div");
    render(renderAbout(createProps()), container);

    expect(container.querySelector(".about-build-strip")?.textContent).not.toContain("2026.7.9");
    expect(container.querySelector(".about-gateway-row")?.textContent).toContain("2026.7.9");
    expect(container.querySelector(".about-gateway-row")?.textContent).toContain(
      "separate from this Control UI build",
    );
  });

  it("copies the full commit while announcing success accessibly", () => {
    const onCopyCommit = vi.fn();
    const container = document.createElement("div");
    render(renderAbout(createProps({ copyState: "copied", onCopyCommit })), container);

    const button = container.querySelector<HTMLButtonElement>(".about-build-strip__copy");
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

    expect(container.querySelectorAll(".about-build-strip__unavailable")).toHaveLength(4);
    expect(container.querySelector(".about-build-strip__copy")).toBeNull();
    expect(container.textContent).not.toContain("Unknown build");
  });
});
