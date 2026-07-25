// Control UI tests cover public assets behavior.
import { describe, expect, it } from "vitest";
import { controlUiPublicAssetPath, inferControlUiPublicAssetPath } from "./public-assets.ts";

function withConfiguredBasePath<T>(basePath: string, run: () => T): T {
  const key = "__OPENCLAW_CONTROL_UI_BASE_PATH__";
  const previous = Object.getOwnPropertyDescriptor(window, key);
  Object.defineProperty(window, key, { configurable: true, value: basePath });
  try {
    return run();
  } finally {
    if (previous) {
      Object.defineProperty(window, key, previous);
    } else {
      Reflect.deleteProperty(window, key);
    }
  }
}

describe("controlUiPublicAssetPath", () => {
  it("resolves root-mounted public assets from the URL root", () => {
    expect(controlUiPublicAssetPath("favicon.svg", "")).toBe("/favicon.svg");
    expect(controlUiPublicAssetPath("manifest.webmanifest", null)).toBe("/manifest.webmanifest");
  });

  it("resolves base-mounted public assets under the configured base path", () => {
    expect(controlUiPublicAssetPath("favicon.svg", "/ui")).toBe("/ui/favicon.svg");
    expect(controlUiPublicAssetPath("sw.js", "/apps/openclaw/")).toBe("/apps/openclaw/sw.js");
  });
});

describe("inferControlUiPublicAssetPath", () => {
  it("uses the root for known nested routes without a configured base path", () => {
    expect(
      inferControlUiPublicAssetPath("manifest.webmanifest", { pathname: "/skills/workshop" }),
    ).toBe("/manifest.webmanifest");
  });

  it("infers base-mounted assets from nested routes", () => {
    expect(inferControlUiPublicAssetPath("sw.js", { pathname: "/openclaw/skills/workshop" })).toBe(
      "/openclaw/sw.js",
    );
  });

  it("keeps explicit pathname inference independent from ambient page state", () => {
    expect(
      withConfiguredBasePath("/other", () =>
        inferControlUiPublicAssetPath("sw.js", { pathname: "/openclaw/skills/workshop" }),
      ),
    ).toBe("/openclaw/sw.js");
  });

  it("keeps an about mount root distinct from the settings About route", () => {
    expect(inferControlUiPublicAssetPath("sw.js", { pathname: "/about/" })).toBe("/about/sw.js");
  });

  it("prefers an explicit base path over pathname inference", () => {
    expect(
      inferControlUiPublicAssetPath("apple-touch-icon.png", {
        basePath: "/control/",
        pathname: "/skills/workshop",
      }),
    ).toBe("/control/apple-touch-icon.png");
  });
});
