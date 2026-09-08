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
  it("versions public assets with the document build while keeping the worker revalidating", () => {
    const attribute = "data-openclaw-control-ui-build-id";
    document.documentElement.setAttribute(attribute, "build-a");
    try {
      for (const asset of [
        "favicon.svg",
        "apple-touch-icon.png",
        "manifest.webmanifest",
        "themes/absolutely.css",
        "fonts/lora.css",
        "provider-icons/ProviderIcon-pi.svg",
        "file-icons/compact/dark/pdf.svg",
        "file-icons/large/shell-dark.svg",
        "file-icons/overlays/pdf.svg",
        "plugin-art/example.webp",
        "app-art/example.webp",
        "community-art/example.webp",
      ] as const) {
        expect(controlUiPublicAssetPath(asset, "")).toBe(`/${asset}?v=build-a`);
        expect(controlUiPublicAssetPath(asset, "/control/")).toBe(`/control/${asset}?v=build-a`);
      }
      expect(controlUiPublicAssetPath("sw.js", "/control")).toBe("/control/sw.js");
      document.documentElement.setAttribute(attribute, "build-b");
      expect(
        inferControlUiPublicAssetPath("fonts/lora.css", { resourceBasePath: "/control" }),
      ).toBe("/control/fonts/lora.css?v=build-b");
    } finally {
      document.documentElement.removeAttribute(attribute);
    }
  });

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
    expect(
      inferControlUiPublicAssetPath("favicon.svg", {
        resourceBasePath: "",
        pathname: "/__openclaw__/new",
      }),
    ).toBe("/favicon.svg");
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
        resourceBasePath: "/control/",
        pathname: "/skills/workshop",
      }),
    ).toBe("/control/apple-touch-icon.png");
  });
});
