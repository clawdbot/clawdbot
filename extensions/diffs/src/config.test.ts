import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import AjvPkg from "ajv";
import type { JsonSchemaObject } from "openclaw/plugin-sdk/config-schema";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DIFFS_PLUGIN_SECURITY,
  DEFAULT_DIFFS_TOOL_DEFAULTS,
  diffsPluginConfigSchema,
  resolveDiffImageRenderOptions,
  resolveDiffsPluginDefaults,
  resolveDiffsPluginSecurity,
  resolveDiffsPluginViewerBaseUrl,
} from "./config.js";
import { buildViewerUrl, normalizeViewerBaseUrl } from "./url.js";
import {
  getServedViewerAsset,
  resolveViewerRuntimeFileUrl,
  VIEWER_LOADER_PATH,
  VIEWER_RUNTIME_PATH,
} from "./viewer-assets.js";
import { parseViewerPayloadJson } from "./viewer-payload.js";

const FULL_DEFAULTS = {
  fontFamily: "JetBrains Mono",
  fontSize: 17,
  lineSpacing: 1.8,
  layout: "split",
  showLineNumbers: false,
  diffIndicators: "classic",
  wordWrap: false,
  background: false,
  theme: "light",
  fileFormat: "pdf",
  fileQuality: "hq",
  fileScale: 2.6,
  fileMaxWidth: 1280,
  mode: "file",
  ttlSeconds: 21_600,
} as const;

function compileManifestConfigSchema() {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  ) as { configSchema: JsonSchemaObject };
  const Ajv = AjvPkg as unknown as new (opts?: object) => import("ajv").default;
  const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
  return ajv.compile(manifest.configSchema);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function expectFields(value: unknown, fields: Record<string, unknown>) {
  const record = requireRecord(value, "record");
  for (const [key, expected] of Object.entries(fields)) {
    expect(record[key]).toEqual(expected);
  }
}

describe("resolveDiffsPluginDefaults", () => {
  it("returns built-in defaults when config is missing", () => {
    expect(resolveDiffsPluginDefaults(undefined)).toEqual(DEFAULT_DIFFS_TOOL_DEFAULTS);
  });

  it("applies configured defaults from plugin config", () => {
    expect(
      resolveDiffsPluginDefaults({
        defaults: FULL_DEFAULTS,
      }),
    ).toEqual(FULL_DEFAULTS);
  });

  it("clamps and falls back for invalid line spacing and indicators", () => {
    expectFields(
      resolveDiffsPluginDefaults({
        defaults: {
          lineSpacing: -5,
          diffIndicators: "unknown",
        },
      }),
      {
        lineSpacing: 1,
        diffIndicators: "bars",
      },
    );

    expectFields(
      resolveDiffsPluginDefaults({
        defaults: {
          lineSpacing: 9,
        },
      }),
      {
        lineSpacing: 3,
      },
    );

    expectFields(
      resolveDiffsPluginDefaults({
        defaults: {
          lineSpacing: Number.NaN,
        },
      }),
      {
        lineSpacing: DEFAULT_DIFFS_TOOL_DEFAULTS.lineSpacing,
      },
    );
  });

  it("derives file defaults from quality preset and clamps explicit overrides", () => {
    expectFields(
      resolveDiffsPluginDefaults({
        defaults: {
          fileQuality: "print",
        },
      }),
      {
        fileQuality: "print",
        fileScale: 3,
        fileMaxWidth: 1400,
      },
    );

    expectFields(
      resolveDiffsPluginDefaults({
        defaults: {
          fileQuality: "hq",
          fileScale: 99,
          fileMaxWidth: 99999,
        },
      }),
      {
        fileQuality: "hq",
        fileScale: 4,
        fileMaxWidth: 2400,
      },
    );
  });

  it("falls back to png for invalid file format defaults", () => {
    expectFields(
      resolveDiffsPluginDefaults({
        defaults: {
          fileFormat: "invalid" as "png",
        },
      }),
      {
        fileFormat: "png",
      },
    );
  });

  it("resolves file render format from defaults and explicit overrides", () => {
    const defaults = resolveDiffsPluginDefaults({
      defaults: {
        fileFormat: "pdf",
      },
    });

    expect(resolveDiffImageRenderOptions({ defaults }).format).toBe("pdf");
    expect(resolveDiffImageRenderOptions({ defaults, fileFormat: "png" }).format).toBe("png");
    expect(resolveDiffImageRenderOptions({ defaults, format: "png" }).format).toBe("png");
  });

  it("accepts format as a config alias for fileFormat", () => {
    expectFields(
      resolveDiffsPluginDefaults({
        defaults: {
          format: "pdf",
        },
      }),
      {
        fileFormat: "pdf",
      },
    );
  });

  it("accepts image* config aliases for backward compatibility", () => {
    expectFields(
      resolveDiffsPluginDefaults({
        defaults: {
          imageFormat: "pdf",
          imageQuality: "hq",
          imageScale: 2.2,
          imageMaxWidth: 1024,
        },
      }),
      {
        fileFormat: "pdf",
        fileQuality: "hq",
        fileScale: 2.2,
        fileMaxWidth: 1024,
      },
    );
  });

  it("accepts plugin-wide artifact TTL defaults", () => {
    expectFields(
      resolveDiffsPluginDefaults({
        defaults: {
          ttlSeconds: 21_600,
        },
      }),
      {
        ttlSeconds: 21_600,
      },
    );

    expectFields(
      resolveDiffsPluginDefaults({
        defaults: {
          ttlSeconds: 99_999,
        },
      }),
      {
        ttlSeconds: 21_600,
      },
    );
  });

  it("keeps loader-applied schema defaults from shadowing aliases and quality-derived defaults", () => {
    const validate = compileManifestConfigSchema();

    const aliasOnly = {
      defaults: {
        format: "pdf",
        imageQuality: "hq",
      },
    };
    expect(validate(aliasOnly)).toBe(true);
    expectFields(resolveDiffsPluginDefaults(aliasOnly), {
      fileFormat: "pdf",
      fileQuality: "hq",
      fileScale: 2.5,
      fileMaxWidth: 1200,
    });

    const qualityOnly = {
      defaults: {
        fileQuality: "hq",
      },
    };
    expect(validate(qualityOnly)).toBe(true);
    expectFields(resolveDiffsPluginDefaults(qualityOnly), {
      fileQuality: "hq",
      fileScale: 2.5,
      fileMaxWidth: 1200,
    });
  });
});

describe("resolveDiffsPluginSecurity", () => {
  it("defaults to local-only viewer access", () => {
    expect(resolveDiffsPluginSecurity(undefined)).toEqual(DEFAULT_DIFFS_PLUGIN_SECURITY);
  });

  it("allows opt-in remote viewer access", () => {
    expect(resolveDiffsPluginSecurity({ security: { allowRemoteViewer: true } })).toEqual({
      allowRemoteViewer: true,
    });
  });
});

describe("resolveDiffsPluginViewerBaseUrl", () => {
  it("defaults to undefined when config is missing", () => {
    expect(resolveDiffsPluginViewerBaseUrl(undefined)).toBeUndefined();
  });

  it("normalizes configured viewer base URLs", () => {
    expect(
      resolveDiffsPluginViewerBaseUrl({
        viewerBaseUrl: "https://example.com/openclaw/",
      }),
    ).toBe("https://example.com/openclaw");
  });
});

describe("diffs plugin schema surfaces", () => {
  it("rejects invalid viewerBaseUrl values at manifest-validation time too", () => {
    const validate = compileManifestConfigSchema();

    expect(validate({ viewerBaseUrl: "javascript:alert(1)" })).toBe(false);
    expect(validate({ viewerBaseUrl: "https://example.com/openclaw?x=1" })).toBe(false);
    expect(validate({ viewerBaseUrl: "https://example.com/openclaw#frag" })).toBe(false);
    expect(validate({ viewerBaseUrl: "https://example.com/openclaw/" })).toBe(true);
  });

  it("preserves defaults and security for direct safeParse callers", () => {
    const parsed = requireRecord(
      diffsPluginConfigSchema.safeParse?.({
        viewerBaseUrl: "https://example.com/openclaw/",
        defaults: {
          theme: "light",
          ttlSeconds: 21_600,
        },
        security: {
          allowRemoteViewer: true,
        },
      }),
      "parse result",
    );
    expect(parsed.success).toBe(true);
    const data = requireRecord(parsed.data, "parse data");
    expect(data.viewerBaseUrl).toBe("https://example.com/openclaw");
    expectFields(data.defaults, {
      fontFamily: "Fira Code",
      fontSize: 15,
      lineSpacing: 1.6,
      layout: "unified",
      showLineNumbers: true,
      diffIndicators: "bars",
      wordWrap: true,
      background: true,
      theme: "light",
      fileFormat: "png",
      fileQuality: "standard",
      fileScale: 2,
      fileMaxWidth: 960,
      mode: "both",
      ttlSeconds: 21_600,
    });
    expectFields(data.security, { allowRemoteViewer: true });
  });

  it("canonicalizes alias-driven defaults for direct safeParse callers", () => {
    const parsed = requireRecord(
      diffsPluginConfigSchema.safeParse?.({
        defaults: {
          format: "pdf",
          imageQuality: "hq",
        },
      }),
      "parse result",
    );
    expect(parsed.success).toBe(true);
    const data = requireRecord(parsed.data, "parse data");
    expectFields(data.defaults, {
      fileFormat: "pdf",
      fileQuality: "hq",
      fileScale: 2.5,
      fileMaxWidth: 1200,
    });
  });

  it("rejects invalid viewerBaseUrl config values", () => {
    const parsed = requireRecord(
      diffsPluginConfigSchema.safeParse?.({
        viewerBaseUrl: "javascript:alert(1)",
      }),
      "parse result",
    );
    expect(parsed.success).toBe(false);
    const error = requireRecord(parsed.error, "parse error");
    const issues = error.issues as Array<{ path?: unknown; message?: unknown }>;
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["viewerBaseUrl"]);
    expect(issues[0]?.message).toBe("viewerBaseUrl must use http or https: javascript:alert(1)");
  });

  it("keeps the runtime json schema in sync with the manifest config schema", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { configSchema?: unknown };

    expect(diffsPluginConfigSchema.jsonSchema).toEqual(manifest.configSchema);
  });
});

describe("diffs viewer URL helpers", () => {
  it("defaults to loopback for lan/tailnet bind modes", () => {
    expect(
      buildViewerUrl({
        config: { gateway: { bind: "lan", port: 18789 } },
        viewerPath: "/plugins/diffs/view/id/token",
      }),
    ).toBe("http://127.0.0.1:18789/plugins/diffs/view/id/token");

    expect(
      buildViewerUrl({
        config: { gateway: { bind: "tailnet", port: 24444 } },
        viewerPath: "/plugins/diffs/view/id/token",
      }),
    ).toBe("http://127.0.0.1:24444/plugins/diffs/view/id/token");
  });

  it("uses custom bind host when provided", () => {
    expect(
      buildViewerUrl({
        config: {
          gateway: {
            bind: "custom",
            customBindHost: "gateway.example.com",
            port: 443,
            tls: { enabled: true },
          },
        },
        viewerPath: "/plugins/diffs/view/id/token",
      }),
    ).toBe("https://gateway.example.com/plugins/diffs/view/id/token");
  });

  it("joins viewer path under baseUrl pathname", () => {
    expect(
      buildViewerUrl({
        config: {},
        baseUrl: "https://example.com/openclaw",
        viewerPath: "/plugins/diffs/view/id/token",
      }),
    ).toBe("https://example.com/openclaw/plugins/diffs/view/id/token");
  });

  it("prefers normalized viewerBaseUrl strings too", () => {
    expect(
      buildViewerUrl({
        config: {},
        baseUrl: "https://example.com/openclaw/",
        viewerPath: "/plugins/diffs/view/id/token",
      }),
    ).toBe("https://example.com/openclaw/plugins/diffs/view/id/token");
  });

  it("rejects base URLs with query/hash", () => {
    expect(() => normalizeViewerBaseUrl("https://example.com?a=1")).toThrow(
      "baseUrl must not include query/hash",
    );
    expect(() => normalizeViewerBaseUrl("https://example.com#frag")).toThrow(
      "baseUrl must not include query/hash",
    );
  });

  it("uses the configured field name in viewerBaseUrl validation errors", () => {
    expect(() => normalizeViewerBaseUrl("https://example.com?a=1", "viewerBaseUrl")).toThrow(
      "viewerBaseUrl must not include query/hash",
    );
  });
});

describe("viewer assets", () => {
  it("prefers the built plugin asset layout when present", async () => {
    const repoRoot = join(process.cwd(), "tmp", "diffs-viewer-assets-test-repo");
    const builtRuntimePath = join(
      repoRoot,
      "dist",
      "extensions",
      "diffs",
      "assets",
      "viewer-runtime.js",
    );
    const stat = vi.fn(async (path: string) => {
      if (path === builtRuntimePath) {
        return { mtimeMs: 1 };
      }
      const error = Object.assign(new Error(`missing: ${path}`), { code: "ENOENT" });
      throw error;
    });

    const runtimeUrl = await resolveViewerRuntimeFileUrl({
      baseUrl: pathToFileURL(join(repoRoot, "dist", "extensions", "diffs", "index.js")),
      stat,
    });

    expect(fileURLToPath(runtimeUrl)).toBe(builtRuntimePath);
    expect(stat).toHaveBeenCalledTimes(1);
  });

  it("falls back to the source asset layout when the built artifact is absent", async () => {
    const repoRoot = join(process.cwd(), "tmp", "diffs-viewer-assets-test-repo");
    const sourceCandidatePath = join(
      repoRoot,
      "extensions",
      "diffs",
      "src",
      "assets",
      "viewer-runtime.js",
    );
    const sourceRuntimePath = join(repoRoot, "extensions", "diffs", "assets", "viewer-runtime.js");
    const stat = vi.fn(async (path: string) => {
      if (path === sourceRuntimePath) {
        return { mtimeMs: 1 };
      }
      const error = Object.assign(new Error(`missing: ${path}`), { code: "ENOENT" });
      throw error;
    });

    const runtimeUrl = await resolveViewerRuntimeFileUrl({
      baseUrl: pathToFileURL(join(repoRoot, "extensions", "diffs", "src", "viewer-assets.js")),
      stat,
    });

    expect(fileURLToPath(runtimeUrl)).toBe(sourceRuntimePath);
    expect(stat).toHaveBeenNthCalledWith(1, sourceCandidatePath);
    expect(stat).toHaveBeenNthCalledWith(2, sourceRuntimePath);
  });

  it("serves a stable loader that points at the current runtime bundle", async () => {
    const loader = await getServedViewerAsset(VIEWER_LOADER_PATH);

    expect(loader?.contentType).toBe("text/javascript; charset=utf-8");
    expect(String(loader?.body)).toContain(`./viewer-runtime.js?v=`);
  });

  it("serves the runtime bundle body", async () => {
    const runtime = await getServedViewerAsset(VIEWER_RUNTIME_PATH);

    expect(runtime?.contentType).toBe("text/javascript; charset=utf-8");
    expect(String(runtime?.body)).toContain("openclawDiffsReady");
    expect(String(runtime?.body)).toContain('style.width="24px"');
    expect(String(runtime?.body)).toContain('style.gap="6px"');
  });

  it("returns null for unknown asset paths", async () => {
    await expect(getServedViewerAsset("/plugins/diffs/assets/not-real.js")).resolves.toBeNull();
  });
});

describe("parseViewerPayloadJson", () => {
  function buildValidPayload(): Record<string, unknown> {
    return {
      prerenderedHTML: "<div>ok</div>",
      langs: ["text"],
      oldFile: {
        name: "README.md",
        contents: "before",
      },
      newFile: {
        name: "README.md",
        contents: "after",
      },
      options: {
        theme: {
          light: "pierre-light",
          dark: "pierre-dark",
        },
        diffStyle: "unified",
        diffIndicators: "bars",
        disableLineNumbers: false,
        expandUnchanged: false,
        themeType: "dark",
        backgroundEnabled: true,
        overflow: "wrap",
        unsafeCSS: ":host{}",
      },
    };
  }

  it("accepts valid payload JSON", () => {
    const parsed = parseViewerPayloadJson(JSON.stringify(buildValidPayload()));
    expect(parsed.options.diffStyle).toBe("unified");
    expect(parsed.options.diffIndicators).toBe("bars");
  });

  it("rejects payloads with invalid shape", () => {
    const broken = buildValidPayload();
    broken.options = {
      ...(broken.options as Record<string, unknown>),
      diffIndicators: "invalid",
    };

    expect(() => parseViewerPayloadJson(JSON.stringify(broken))).toThrow(
      "Diff payload has invalid shape.",
    );
  });

  it("rejects invalid JSON", () => {
    expect(() => parseViewerPayloadJson("{not-json")).toThrow("Diff payload is not valid JSON.");
  });
});
