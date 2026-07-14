// Control UI tests cover custom theme behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createImportedCustomThemeFixture as createImportedTheme,
  createTweakcnThemePayload as createTweakcnPayload,
} from "../test-helpers/custom-theme.ts";
import {
  importCustomThemeFromUrl,
  parseImportedCustomTheme,
  syncCustomThemeStyleTag,
} from "./custom-theme.ts";
import type { ImportedCustomTheme } from "./custom-theme.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

function firstFetchCall(
  fetchImpl: typeof fetch,
): [string, { headers?: unknown; redirect?: unknown; signal?: unknown }] {
  const call = vi.mocked(fetchImpl).mock.calls[0] as
    | [string, { headers?: unknown; redirect?: unknown; signal?: unknown }]
    | undefined;
  if (!call) {
    throw new Error("expected fetch call");
  }
  return call;
}

describe("custom theme import helpers", () => {
  it("keeps imported theme labels on a UTF-16 boundary", () => {
    const parsed = parseImportedCustomTheme({
      ...createImportedTheme(),
      label: `${"a".repeat(79)}🚀tail`,
    });

    expect(parsed?.label).toBe("a".repeat(79));
  });

  it("fetches tweakcn themes with bounded no-redirect requests", async () => {
    const response = createResponse(JSON.stringify(createTweakcnPayload()));
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch;

    const imported = await importCustomThemeFromUrl(
      "https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z",
      fetchImpl,
    );

    expect(imported.label).toBe("Light Green");
    expect(imported.sourceUrl).toBe("https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z");
    expect(imported.light.bg).toBe("oklch(0.98 0.01 120)");
    expect(imported.dark.bg).toBe("oklch(0.12 0.04 265)");
    expect(imported.light["font-body"]).toBe("Inter, system-ui, sans-serif");
    expect(imported.dark["accent-hover"]).toBe("color-mix(in srgb, var(--accent) 82%, white 18%)");
    const fetchMock = vi.mocked(fetchImpl);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [fetchUrl, fetchOptions] = firstFetchCall(fetchImpl);
    expect(fetchUrl).toBe("https://tweakcn.com/r/themes/cmlhfpjhw000004l4f4ax3m7z");
    expect(fetchOptions.signal).toBeInstanceOf(AbortSignal);
    expect(fetchOptions).toEqual({
      headers: { accept: "application/json" },
      redirect: "error",
      signal: fetchOptions.signal,
    });
  });

  it.each([
    "https://tweakcn.com/editor/theme?theme=cmlhfpjhw000004l4f4ax3m7z",
    "https://tweakcn.com/r/themes/cmlhfpjhw000004l4f4ax3m7z",
    "/r/themes/cmlhfpjhw000004l4f4ax3m7z",
    "cmlhfpjhw000004l4f4ax3m7z",
    "Theme link: https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z.",
  ])("imports supported tweakcn input form %s", async (input) => {
    const fetchImpl = vi.fn(async () =>
      createResponse(JSON.stringify(createTweakcnPayload())),
    ) as unknown as typeof fetch;

    const imported = await importCustomThemeFromUrl(input, fetchImpl);

    expect(imported.themeId).toBe("cmlhfpjhw000004l4f4ax3m7z");
    expect(imported.sourceUrl).toBe("https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z");
    expect(firstFetchCall(fetchImpl)[0]).toBe(
      "https://tweakcn.com/r/themes/cmlhfpjhw000004l4f4ax3m7z",
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
    expect(response["text"]).not.toHaveBeenCalled();
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

  it.each([
    ['url("https://example.com/track")', "background"],
    ["oklch(0.98 0.01 120)/*", "background"],
    ['image-set("https://example.com/pixel.png" 1x)', "background"],
    ["var(--attacker-font)", "font-sans"],
  ])("rejects unsafe imported CSS token %s", async (token, key) => {
    const payload = createTweakcnPayload();
    if (key === "font-sans") {
      payload.cssVars.theme[key] = token;
    } else {
      payload.cssVars.light.background = token;
    }
    const fetchImpl = vi.fn(async () =>
      createResponse(JSON.stringify(payload)),
    ) as unknown as typeof fetch;

    await expect(
      importCustomThemeFromUrl("https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z", fetchImpl),
    ).rejects.toThrow("Unsupported tweakcn token");
  });

  it("validates imported font families without regex backtracking", async () => {
    const payload = createTweakcnPayload();
    payload.cssVars.theme["font-sans"] = `${"Inter, ".repeat(20)}@bad`;
    const fetchImpl = vi.fn(async () =>
      createResponse(JSON.stringify(payload)),
    ) as unknown as typeof fetch;

    await expect(
      importCustomThemeFromUrl("https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z", fetchImpl),
    ).rejects.toThrow("Unsupported tweakcn token");
  });

  it("parses stored imported themes and rejects malformed records", () => {
    const imported = createImportedTheme();

    const parsed = parseImportedCustomTheme(imported);
    if (!parsed) {
      throw new Error("Expected imported custom theme to parse");
    }
    expect(parsed.themeId).toBe("cmlhfpjhw000004l4f4ax3m7z");
    expect(parseImportedCustomTheme({ ...imported, themeId: "claude" })?.themeId).toBe("claude");
    expect(parseImportedCustomTheme({ ...imported, light: {} })).toBeNull();
  });

  it("syncs the managed custom theme style tag in the document head", () => {
    const appendChild = vi.fn();
    const remove = vi.fn();
    const style = { id: "", textContent: "", remove } as unknown as HTMLStyleElement;
    const createElement = vi.fn(() => style);
    const documentStub = {
      head: { appendChild },
      createElement,
      getElementById: vi.fn(() => null),
    } as unknown as Document;
    vi.stubGlobal("document", documentStub);

    syncCustomThemeStyleTag(createImportedTheme());

    expect(appendChild).toHaveBeenCalledWith(style);
    expect(style.id).toBe("openclaw-custom-theme");
    expect(style.textContent).toContain(':root[data-theme="custom"]');

    vi.stubGlobal("document", {
      head: documentStub.head,
      createElement,
      getElementById: vi.fn(() => style),
    } as unknown as Document);
    syncCustomThemeStyleTag(null);
    expect(remove).toHaveBeenCalledOnce();
  });

  it("removes the managed style tag when a stored theme is missing tokens", () => {
    const remove = vi.fn();
    vi.stubGlobal("document", {
      getElementById: vi.fn(() => ({ remove })),
    } as unknown as Document);
    const theme = { ...createImportedTheme(), light: undefined } as unknown as ImportedCustomTheme;

    syncCustomThemeStyleTag(theme);

    expect(remove).toHaveBeenCalledOnce();
  });
});
