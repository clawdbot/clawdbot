import fs from "node:fs";
import path from "node:path";
import { pluginSdkEntrypoints } from "./lib/plugin-sdk-entries.mjs";

const RUNTIME_SHIMS: Partial<Record<string, string>> = {
  "webhook-path": [
    "/** Normalize webhook paths into the canonical registry form used by route lookup. */",
    "export function normalizeWebhookPath(raw) {",
    "  const trimmed = raw.trim();",
    "  if (!trimmed) {",
    '    return "/";',
    "  }",
    '  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;',
    '  if (withSlash.length > 1 && withSlash.endsWith("/")) {',
    "    return withSlash.slice(0, -1);",
    "  }",
    "  return withSlash;",
    "}",
    "",
    "/** Resolve the effective webhook path from explicit path, URL, or default fallback. */",
    "export function resolveWebhookPath(params) {",
    "  const trimmedPath = params.webhookPath?.trim();",
    "  if (trimmedPath) {",
    "    return normalizeWebhookPath(trimmedPath);",
    "  }",
    "  if (params.webhookUrl?.trim()) {",
    "    try {",
    "      const parsed = new URL(params.webhookUrl);",
    '      return normalizeWebhookPath(parsed.pathname || "/");',
    "    } catch {",
    "      return null;",
    "    }",
    "  }",
    "  return params.defaultPath ?? null;",
    "}",
    "",
  ].join("\n"),
};

// `tsc` emits declarations under `dist/plugin-sdk/src/plugin-sdk/*` because the source lives
// at `src/plugin-sdk/*` and `rootDir` is `.` (repo root, to support cross-src/extensions refs).
//
// Our package export map points subpath `types` at `dist/plugin-sdk/<entry>.d.ts`, so we
// generate stable entry d.ts files that re-export the real declarations.
for (const entry of pluginSdkEntrypoints) {
  const typeOut = path.join(process.cwd(), `dist/plugin-sdk/${entry}.d.ts`);
  fs.mkdirSync(path.dirname(typeOut), { recursive: true });
  fs.writeFileSync(typeOut, `export * from "./src/plugin-sdk/${entry}.js";\n`, "utf8");

  const packageTypeOut = path.join(
    process.cwd(),
    `packages/plugin-sdk/dist/src/plugin-sdk/${entry}.d.ts`,
  );
  fs.mkdirSync(path.dirname(packageTypeOut), { recursive: true });
  fs.writeFileSync(
    packageTypeOut,
    `export * from "../../../../../dist/plugin-sdk/${entry}.js";\n`,
    "utf8",
  );

  const runtimeShim = RUNTIME_SHIMS[entry];
  if (!runtimeShim) {
    continue;
  }
  const runtimeOut = path.join(process.cwd(), `dist/plugin-sdk/${entry}.js`);
  fs.mkdirSync(path.dirname(runtimeOut), { recursive: true });
  fs.writeFileSync(runtimeOut, runtimeShim, "utf8");
}

const stampPath = path.join(process.cwd(), "dist/plugin-sdk/.boundary-entry-shims.stamp");
fs.mkdirSync(path.dirname(stampPath), { recursive: true });
fs.writeFileSync(stampPath, `${new Date().toISOString()}\n`, "utf8");
