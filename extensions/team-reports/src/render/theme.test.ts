import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { shell } from "./page.js";

const pages: JSDOM[] = [];
afterEach(() => {
  for (const page of pages.splice(0)) {
    page.window.close();
  }
});

async function openPage(
  options: {
    hash?: string;
    stored?: string;
    blockedStorage?: boolean;
    systemLight?: boolean;
    url?: string;
  } = {},
) {
  const html = shell(
    {
      basePath: "/team/reports",
      nonce: "fixture",
      absoluteUrl: "https://public.example/team/reports/day/2026-09-07/?person=alice",
      displayTimezone: "UTC",
    },
    "Theme fixture",
    `<a id="history" href="/team/reports/day/2026-09-06/?person=alice#theme=dark">History</a><a id="absolute" href="https://gateway.example/team/reports/people/">People</a><a id="external" href="https://external.example/team/reports/">External</a><a id="outside" href="/team/reports-other/">Outside</a>`,
    "home",
  );
  const page = new JSDOM(html, {
    url: options.url ?? `https://gateway.example/team/reports/${options.hash ?? ""}`,
    runScripts: "dangerously",
    beforeParse(window) {
      Object.defineProperty(window, "matchMedia", {
        value: () => ({ matches: options.systemLight ?? false, addEventListener() {} }),
      });
      if (options.blockedStorage) {
        Object.defineProperty(window, "localStorage", {
          get() {
            throw new window.DOMException("Storage blocked by sandbox", "SecurityError");
          },
        });
      } else if (options.stored) {
        window.localStorage.setItem("theme", options.stored);
      }
    },
  });
  pages.push(page);
  // The head script must choose the theme before body parsing and enhancement.
  const headTheme = page.window.document.documentElement.dataset.theme;
  await new Promise<void>((resolve) => {
    page.window.addEventListener("load", () => resolve(), { once: true });
  });
  return { page, headTheme };
}

function link(page: JSDOM, selector: string): string | null | undefined {
  return page.window.document.querySelector(selector)?.getAttribute("href");
}

function toggle(page: JSDOM): void {
  page.window.document.querySelector<HTMLButtonElement>("[data-theme-toggle]")?.click();
}

describe("Team Reports theme navigation", () => {
  it.each([
    { hash: "#theme=light", stored: "dark", systemLight: false, expected: "light" },
    { hash: "#theme=dark", stored: "light", systemLight: true, expected: "dark" },
    { hash: "#theme=invalid", stored: "light", systemLight: false, expected: "light" },
    { hash: "", stored: "invalid", systemLight: true, expected: "light" },
  ])("resolves the head theme from fragment, storage, then OS ($hash/$stored)", async (options) => {
    const { headTheme } = await openPage(options);
    expect(headTheme).toBe(options.expected);
  });

  it("carries a sandboxed theme across internal navigation without changing external destinations", async () => {
    const { page } = await openPage({ blockedStorage: true });
    toggle(page);
    expect(page.window.document.documentElement.dataset.theme).toBe("light");
    expect(page.window.location.hash).toBe("#theme=light");
    expect(link(page, "#history")).toBe("/team/reports/day/2026-09-06/?person=alice#theme=light");
    expect(link(page, "#absolute")).toBe(
      "https://gateway.example/team/reports/people/#theme=light",
    );
    expect(link(page, 'a[aria-current="page"]')).toBe("/team/reports/#theme=light");
    expect(link(page, 'a[aria-label="Open in a new window"]')).toBe(
      "https://public.example/team/reports/day/2026-09-07/?person=alice#theme=light",
    );
    expect(link(page, "#external")).toBe("https://external.example/team/reports/");
    expect(link(page, "#outside")).toBe("/team/reports-other/");
    const next = await openPage({
      url: new URL(link(page, "#history") ?? "", page.window.location.href).href,
      blockedStorage: true,
    });
    expect(next.headTheme).toBe("light");
    expect(link(next.page, 'a[aria-current="page"]')).toBe("/team/reports/#theme=light");
    toggle(next.page);
    expect(next.page.window.location.hash).toBe("#theme=dark");
    expect(link(next.page, "#history")).toBe(
      "/team/reports/day/2026-09-06/?person=alice#theme=dark",
    );
  });

  it("persists a separate-window theme when browser storage is available", async () => {
    const { page } = await openPage({ stored: "dark" });
    toggle(page);
    expect(page.window.localStorage.getItem("theme")).toBe("light");
    const next = await openPage({ stored: page.window.localStorage.getItem("theme") ?? undefined });
    expect(next.headTheme).toBe("light");
  });
});
