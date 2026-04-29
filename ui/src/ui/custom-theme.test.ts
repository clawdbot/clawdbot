import { describe, expect, it, vi } from "vitest";
import {
  buildCustomThemeStyles,
  importCustomThemeFromUrl,
  normalizeImportedCustomTheme,
  normalizeTweakcnThemeUrl,
  parseImportedCustomTheme,
  syncCustomThemeStyleTag,
} from "./custom-theme.ts";
import type { ImportedCustomTheme } from "./custom-theme.ts";

function createTweakcnPayload() {
  return {
    name: "Light Green",
    cssVars: {
      theme: {
        "font-sans": "Inter, system-ui, sans-serif",
        "font-mono": "JetBrains Mono, monospace",
      },
      light: {
        background: "oklch(0.98 0.01 120)",
        foreground: "oklch(0.2 0.03 265)",
        card: "oklch(1 0 0)",
        "card-foreground": "oklch(0.2 0.03 265)",
        popover: "oklch(1 0 0)",
        "popover-foreground": "oklch(0.2 0.03 265)",
        primary: "oklch(0.8 0.2 128)",
        "primary-foreground": "oklch(0 0 0)",
        secondary: "oklch(0.35 0.03 257)",
        "secondary-foreground": "oklch(0.98 0.01 248)",
        muted: "oklch(0.96 0.01 248)",
        "muted-foreground": "oklch(0.55 0.04 257)",
        accent: "oklch(0.98 0.02 155)",
        "accent-foreground": "oklch(0.45 0.1 151)",
        destructive: "oklch(0.64 0.2 25)",
        "destructive-foreground": "oklch(1 0 0)",
        border: "oklch(0.92 0.01 255)",
        input: "oklch(0.92 0.01 255)",
        ring: "oklch(0.8 0.2 128)",
      },
      dark: {
        background: "oklch(0.12 0.04 265)",
        foreground: "oklch(0.98 0.01 248)",
        card: "oklch(0.2 0.04 266)",
        "card-foreground": "oklch(0.98 0.01 248)",
        popover: "oklch(0.2 0.04 266)",
        "popover-foreground": "oklch(0.98 0.01 248)",
        primary: "oklch(0.8 0.2 128)",
        "primary-foreground": "oklch(0 0 0)",
        secondary: "oklch(0.28 0.04 260)",
        "secondary-foreground": "oklch(0.98 0.01 248)",
        muted: "oklch(0.28 0.04 260)",
        "muted-foreground": "oklch(0.71 0.03 257)",
        accent: "oklch(0.39 0.09 152)",
        "accent-foreground": "oklch(0.8 0.2 128)",
        destructive: "oklch(0.44 0.16 27)",
        "destructive-foreground": "oklch(1 0 0)",
        border: "oklch(0.28 0.04 260)",
        input: "oklch(0.28 0.04 260)",
        ring: "oklch(0.8 0.2 128)",
      },
    },
  };
}

function createImportedTheme() {
  return normalizeImportedCustomTheme(createTweakcnPayload(), {
    sourceUrl: "https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z",
    themeId: "cmlhfpjhw000004l4f4ax3m7z",
  });
}

function createResponse(
  body: string,
  options: {
    body?: ReadableStream<Uint8Array> | null;
    headers?: HeadersInit;
    status?: number;
    url?: string;
  } = {},
) {
  return {
    ok: (options.status ?? 200) >= 200 && (options.status ?? 200) < 300,
    status: options.status ?? 200,
    headers: new Headers(options.headers),
    body:
      options.body === undefined
        ? new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(body));
              controller.close();
            },
          })
        : options.body,
    text: vi.fn(async () => body),
    url: options.url ?? "",
  } as unknown as Response;
}

describe("custom theme import helpers", () => {
  it("normalizes tweakcn share links and raw registry links", () => {
    expect(
      normalizeTweakcnThemeUrl("https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z"),
    ).toEqual({
      sourceUrl: "https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z",
      fetchUrl: "https://tweakcn.com/r/themes/cmlhfpjhw000004l4f4ax3m7z",
      themeId: "cmlhfpjhw000004l4f4ax3m7z",
    });
    expect(
      normalizeTweakcnThemeUrl("https://tweakcn.com/r/themes/cmlhfpjhw000004l4f4ax3m7z"),
    ).toEqual({
      sourceUrl: "https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z",
      fetchUrl: "https://tweakcn.com/r/themes/cmlhfpjhw000004l4f4ax3m7z",
      themeId: "cmlhfpjhw000004l4f4ax3m7z",
    });
    expect(normalizeTweakcnThemeUrl("/r/themes/cmlhfpjhw000004l4f4ax3m7z")).toEqual({
      sourceUrl: "https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z",
      fetchUrl: "https://tweakcn.com/r/themes/cmlhfpjhw000004l4f4ax3m7z",
      themeId: "cmlhfpjhw000004l4f4ax3m7z",
    });
    expect(normalizeTweakcnThemeUrl("cmlhfpjhw000004l4f4ax3m7z")).toEqual({
      sourceUrl: "https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z",
      fetchUrl: "https://tweakcn.com/r/themes/cmlhfpjhw000004l4f4ax3m7z",
      themeId: "cmlhfpjhw000004l4f4ax3m7z",
    });
  });

  it("extracts theme ids from copied tweakcn editor URLs and pasted text", () => {
    expect(
      normalizeTweakcnThemeUrl("https://tweakcn.com/editor/theme?theme=cmlhfpjhw000004l4f4ax3m7z"),
    ).toEqual({
      sourceUrl: "https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z",
      fetchUrl: "https://tweakcn.com/r/themes/cmlhfpjhw000004l4f4ax3m7z",
      themeId: "cmlhfpjhw000004l4f4ax3m7z",
    });
    expect(
      normalizeTweakcnThemeUrl("Theme link: https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z"),
    ).toEqual({
      sourceUrl: "https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z",
      fetchUrl: "https://tweakcn.com/r/themes/cmlhfpjhw000004l4f4ax3m7z",
      themeId: "cmlhfpjhw000004l4f4ax3m7z",
    });
    expect(
      normalizeTweakcnThemeUrl("https://tweakcn.com/editor/theme?theme=amethyst-haze"),
    ).toEqual({
      sourceUrl: "https://tweakcn.com/themes/amethyst-haze",
      fetchUrl: "https://tweakcn.com/r/themes/amethyst-haze",
      themeId: "amethyst-haze",
    });
    expect(normalizeTweakcnThemeUrl("amethyst-haze")).toEqual({
      sourceUrl: "https://tweakcn.com/themes/amethyst-haze",
      fetchUrl: "https://tweakcn.com/r/themes/amethyst-haze",
      themeId: "amethyst-haze",
    });
  });

  it("maps a tweakcn payload into a normalized imported theme record", () => {
    const imported = createImportedTheme();

    expect(imported.label).toBe("Light Green");
    expect(imported.sourceUrl).toBe("https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z");
    expect(imported.light.bg).toBe("oklch(0.98 0.01 120)");
    expect(imported.dark.bg).toBe("oklch(0.12 0.04 265)");
    expect(imported.light["font-body"]).toBe("Inter, system-ui, sans-serif");
    expect(imported.dark["accent-hover"]).toContain("color-mix");
  });

  it("fetches tweakcn themes with bounded no-redirect requests", async () => {
    const response = createResponse(JSON.stringify(createTweakcnPayload()));
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch;

    const imported = await importCustomThemeFromUrl(
      "https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z",
      fetchImpl,
    );

    expect(imported.label).toBe("Light Green");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://tweakcn.com/r/themes/cmlhfpjhw000004l4f4ax3m7z",
      expect.objectContaining({
        headers: { accept: "application/json" },
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("rejects oversized tweakcn theme responses before parsing", async () => {
    const response = createResponse("{}", {
      headers: { "content-length": "200001" },
    });
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch;

    await expect(
      importCustomThemeFromUrl("https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z", fetchImpl),
    ).rejects.toThrow("too large");
  });

  it("rejects tweakcn theme responses without a bounded body stream", async () => {
    const response = createResponse(JSON.stringify(createTweakcnPayload()), { body: null });
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch;

    await expect(
      importCustomThemeFromUrl("https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z", fetchImpl),
    ).rejects.toThrow("unreadable theme payload");
    expect(response.text).not.toHaveBeenCalled();
  });

  it("rejects redirected tweakcn import responses", async () => {
    const response = createResponse(JSON.stringify(createTweakcnPayload()), {
      url: "https://example.com/r/themes/cmlhfpjhw000004l4f4ax3m7z",
    });
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch;

    await expect(
      importCustomThemeFromUrl("https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z", fetchImpl),
    ).rejects.toThrow("Unexpected redirect");
  });

  it("rejects CSS tokens that can escape variables or trigger external requests", () => {
    const payload = createTweakcnPayload();
    payload.cssVars.light.background = 'url("https://example.com/track")';

    expect(() =>
      normalizeImportedCustomTheme(payload, {
        sourceUrl: "https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z",
        themeId: "cmlhfpjhw000004l4f4ax3m7z",
      }),
    ).toThrow("Unsupported tweakcn token");

    payload.cssVars.light.background = "oklch(0.98 0.01 120)/*";
    expect(() =>
      normalizeImportedCustomTheme(payload, {
        sourceUrl: "https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z",
        themeId: "cmlhfpjhw000004l4f4ax3m7z",
      }),
    ).toThrow("Unsupported tweakcn token");

    payload.cssVars.light.background = 'image-set("https://example.com/pixel.png" 1x)';
    expect(() =>
      normalizeImportedCustomTheme(payload, {
        sourceUrl: "https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z",
        themeId: "cmlhfpjhw000004l4f4ax3m7z",
      }),
    ).toThrow("Unsupported tweakcn token");

    payload.cssVars.light.background = "oklch(0.98 0.01 120)";
    payload.cssVars.theme["font-sans"] = "var(--attacker-font)";
    expect(() =>
      normalizeImportedCustomTheme(payload, {
        sourceUrl: "https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z",
        themeId: "cmlhfpjhw000004l4f4ax3m7z",
      }),
    ).toThrow("Unsupported tweakcn token");
  });

  it("validates imported font families without regex backtracking", () => {
    const payload = createTweakcnPayload();
    payload.cssVars.theme["font-sans"] =
      '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

    expect(
      normalizeImportedCustomTheme(payload, {
        sourceUrl: "https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z",
        themeId: "cmlhfpjhw000004l4f4ax3m7z",
      }).light["font-body"],
    ).toBe('"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif');

    payload.cssVars.theme["font-sans"] = `${"Inter, ".repeat(20)}@bad`;
    expect(() =>
      normalizeImportedCustomTheme(payload, {
        sourceUrl: "https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z",
        themeId: "cmlhfpjhw000004l4f4ax3m7z",
      }),
    ).toThrow("Unsupported tweakcn token");
  });

  it("builds stable CSS blocks for custom dark and light themes", () => {
    const css = buildCustomThemeStyles(createImportedTheme());

    expect(css).toContain(':root[data-theme="custom"]');
    expect(css).toContain(':root[data-theme="custom-light"]');
    expect(css).toContain("--bg: oklch(0.12 0.04 265);");
    expect(css).toContain("--bg: oklch(0.98 0.01 120);");
  });

  it("throws when stored custom theme tokens are missing", () => {
    const theme = { ...createImportedTheme(), light: undefined } as unknown as ImportedCustomTheme;

    expect(() => buildCustomThemeStyles(theme)).toThrow(
      "Stored custom theme is missing required tokens.",
    );
  });

  it("parses stored imported themes and rejects malformed records", () => {
    const imported = createImportedTheme();

    expect(parseImportedCustomTheme(imported)?.themeId).toBe("cmlhfpjhw000004l4f4ax3m7z");
    expect(parseImportedCustomTheme({ ...imported, light: {} })).toBeNull();
  });

  it("syncs the managed custom theme style tag in the document head", () => {
    const appendChild = vi.fn();
    const remove = vi.fn();
    const style = { id: "", textContent: "", remove } as unknown as HTMLStyleElement;
    const documentStub = {
      head: { appendChild },
      createElement: vi.fn(() => style),
      getElementById: vi.fn(() => null),
    } as unknown as Document;
    vi.stubGlobal("document", documentStub);

    syncCustomThemeStyleTag(createImportedTheme());

    expect(appendChild).toHaveBeenCalledWith(style);
    expect(style.textContent).toContain(':root[data-theme="custom"]');

    vi.stubGlobal("document", {
      head: documentStub.head,
      createElement: documentStub.createElement,
      getElementById: vi.fn(() => style),
    } as unknown as Document);

    syncCustomThemeStyleTag(null);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
