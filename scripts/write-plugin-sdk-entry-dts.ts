import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "tsdown";
import {
  buildPluginSdkEntrySources,
  pluginSdkEntrypoints,
  publicPluginSdkEntrypoints,
} from "./lib/plugin-sdk-entries.mjs";

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

function isBareImportSpecifier(id: string): boolean {
  if (
    id === "@openclaw/llm-core" ||
    id.startsWith("@openclaw/llm-core/") ||
    id === "@openclaw/model-catalog-core/model-catalog-types" ||
    id.startsWith("@openclaw/normalization-core/") ||
    id.startsWith("@openclaw/media-core/") ||
    id.startsWith("@openclaw/acp-core/")
  ) {
    return false;
  }
  return !id.startsWith(".") && !id.startsWith("/") && !/^[A-Za-z]:[\\/]/u.test(id);
}

function removeExistingFlatDeclarations(outDir: string): void {
  if (!fs.existsSync(outDir)) {
    return;
  }
  for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".d.ts")) {
      continue;
    }
    fs.rmSync(path.join(outDir, entry.name), { force: true });
  }
}

function copyFlatDeclarations(fromDir: string, toDir: string): void {
  fs.mkdirSync(toDir, { recursive: true });
  for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".d.ts")) {
      continue;
    }
    fs.copyFileSync(path.join(fromDir, entry.name), path.join(toDir, entry.name));
  }
}

const distPluginSdkDir = path.join(process.cwd(), "dist/plugin-sdk");
const flatDeclarationTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-sdk-dts-"));
const shouldBuildPrivateQaEntries = process.env.OPENCLAW_BUILD_PRIVATE_QA === "1";
const flatDeclarationEntrypoints = shouldBuildPrivateQaEntries
  ? pluginSdkEntrypoints
  : publicPluginSdkEntrypoints;
const flatDeclarationEntrypointSet = new Set(flatDeclarationEntrypoints);

try {
  await build({
    clean: true,
    config: false,
    deps: { neverBundle: (id) => isBareImportSpecifier(id) },
    dts: true,
    entry: buildPluginSdkEntrySources(flatDeclarationEntrypoints),
    failOnWarn: false,
    fixedExtension: false,
    format: "esm",
    logLevel: "error",
    outDir: flatDeclarationTempDir,
    outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
    platform: "node",
    report: false,
    tsconfig: "tsconfig.plugin-sdk.dts.json",
  });

  removeExistingFlatDeclarations(distPluginSdkDir);
  copyFlatDeclarations(flatDeclarationTempDir, distPluginSdkDir);
} finally {
  fs.rmSync(flatDeclarationTempDir, { recursive: true, force: true });
}

// The root npm package ships flat bundled declarations under `dist/plugin-sdk`.
// The private workspace package keeps source-shaped declaration paths for local
// package-boundary projects, so bridge them back to the packaged flat entries.
for (const entry of pluginSdkEntrypoints) {
  if (!flatDeclarationEntrypointSet.has(entry)) {
    continue;
  }

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
