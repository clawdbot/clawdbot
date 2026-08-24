#!/usr/bin/env -S node --import tsx

/**
 * Verifies that public plugin-sdk subpaths are present in the compiled dist output.
 *
 * Run after the package build to catch missing exports or leaked repo-only type aliases
 * before release.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MAX_PRIVATE_QA_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES,
  MAX_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES,
  PLUGIN_SDK_DECLARATION_OUTPUT_VARIANCE_BYTES,
  evaluatePluginSdkDeclarationBudget,
  isPrivateQaPluginSdkBuild,
} from "./lib/plugin-sdk-declaration-budget.mts";
import { publicPluginSdkEntrypoints, publicPluginSdkSubpaths } from "./lib/plugin-sdk-entries.mts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const nativePreviewPackageJsonPath = resolve(
  repoRoot,
  "node_modules/@typescript/native-preview/package.json",
);
const nativePreviewPackageJson = JSON.parse(readFileSync(nativePreviewPackageJsonPath, "utf8")) as {
  bin?: { tsgo?: string };
};
const nativePreviewTsgoBin = nativePreviewPackageJson.bin?.tsgo;
if (!nativePreviewTsgoBin) {
  throw new Error("@typescript/native-preview does not declare the tsgo binary");
}
const tsgoPath = resolve(dirname(nativePreviewPackageJsonPath), nativePreviewTsgoBin);
const forbiddenPublicDeclarationSpecifiers = ["@openclaw/llm-core"];
const FORBIDDEN_PUBLIC_PROTOCOL_REGISTRY_RE = /\bdeclare\s+const\s+ProtocolSchemas(?:\$\d+)?\b/u;
const RELATIVE_DECLARATION_SPECIFIER_RE = /\b(?:from|import)\s*(?:\(\s*)?["']([^"']+)["']/gu;
const requiredSubpathExports: Record<string, string[]> = {
  "secret-input-runtime": [
    "coerceSecretRef",
    "hasConfiguredSecretInput",
    "isSecretRef",
    "normalizeResolvedSecretInputString",
    "normalizeSecretInputString",
    "resolveSecretInputString",
  ],
};

let missing = 0;

{
  const tempRoot = mkdtempSync(join(tmpdir(), "openclaw-plugin-sdk-consumer-"));
  const consumerRoot = join(tempRoot, "consumer");
  try {
    mkdirSync(consumerRoot, { recursive: true });
    writeFileSync(
      join(consumerRoot, "index.ts"),
      `import { buildChannelConfigSchema, DmPolicySchema } from "openclaw/plugin-sdk/channel-config-schema";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore, type PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { z } from "zod";

const runtimeStore = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "package-consumer",
  errorMessage: "package consumer runtime not initialized",
});
export const configSchema = buildChannelConfigSchema(
  z.object({ dmPolicy: DmPolicySchema.optional() }),
);

declare const plugin: Parameters<typeof defineChannelPluginEntry>[0]["plugin"];
export default defineChannelPluginEntry({
  id: "package-consumer",
  name: "Package Consumer",
  description: "Published Plugin SDK declaration compatibility fixture",
  plugin,
  setRuntime: runtimeStore.setRuntime,
});
`,
    );
    writeFileSync(join(consumerRoot, "package.json"), '{"private":true,"type":"module"}\n');
    writeFileSync(
      join(consumerRoot, "tsconfig.json"),
      `{
  "compilerOptions": {
    "lib": ["DOM", "DOM.Iterable", "ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "noEmit": true,
    "skipLibCheck": true,
    "strict": true,
    "types": []
  },
  "include": ["index.ts"]
}
`,
    );
    const openclawPackagePath = join(consumerRoot, "node_modules", "openclaw");
    mkdirSync(dirname(openclawPackagePath), { recursive: true });
    symlinkSync(repoRoot, openclawPackagePath, process.platform === "win32" ? "junction" : "dir");
    symlinkSync(
      join(repoRoot, "node_modules", "zod"),
      join(consumerRoot, "node_modules", "zod"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const result = spawnSync(
      process.execPath,
      [tsgoPath, "-p", join(consumerRoot, "tsconfig.json"), "--pretty", "false"],
      { cwd: consumerRoot, encoding: "utf8" },
    );
    if (result.error) {
      console.error("BROKEN PLUGIN SDK CONSUMER: failed to start tsgo");
      console.error(result.error.message);
      missing += 1;
    } else if (result.status !== 0) {
      console.error("BROKEN PLUGIN SDK CONSUMER: mixed public subpaths are not assignable");
      process.stderr.write(result.stdout || "");
      process.stderr.write(result.stderr || "");
      missing += 1;
    }
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

for (const entry of publicPluginSdkSubpaths) {
  const jsPath = resolve(scriptDir, "..", "dist", "plugin-sdk", `${entry}.js`);
  const dtsPath = resolve(scriptDir, "..", "dist", "plugin-sdk", `${entry}.d.ts`);
  if (!existsSync(jsPath)) {
    console.error(`MISSING SUBPATH JS: dist/plugin-sdk/${entry}.js`);
    missing += 1;
  }
  if (!existsSync(dtsPath)) {
    console.error(`MISSING SUBPATH DTS: dist/plugin-sdk/${entry}.d.ts`);
    missing += 1;
  }
}

for (const [entry, names] of Object.entries(requiredSubpathExports)) {
  const jsPath = resolve(scriptDir, "..", "dist", "plugin-sdk", `${entry}.js`);
  if (!existsSync(jsPath)) {
    continue;
  }
  let runtime: Record<string, unknown>;
  try {
    runtime = (await import(pathToFileURL(jsPath).href)) as Record<string, unknown>;
  } catch (err) {
    console.error(`BROKEN SUBPATH JS: dist/plugin-sdk/${entry}.js`);
    console.error(err instanceof Error ? err.message : String(err));
    missing += 1;
    continue;
  }
  for (const name of names) {
    if (typeof runtime[name] !== "function") {
      console.error(`MISSING SUBPATH EXPORT: dist/plugin-sdk/${entry}.js#${name}`);
      missing += 1;
    }
  }
}

const distDir = resolve(scriptDir, "..", "dist");
const declarationPaths = new Set<string>();
// Publication checks always start at public roots. Private QA entries are local-only,
// but their unified-build chunk topology can still change declarations reachable here.
const declarationQueue = publicPluginSdkEntrypoints.map((entry: string) =>
  resolve(distDir, "plugin-sdk", `${entry}.d.ts`),
);
while (declarationQueue.length > 0) {
  const dtsPath = declarationQueue.pop();
  if (!dtsPath || declarationPaths.has(dtsPath)) {
    continue;
  }
  if (!existsSync(dtsPath)) {
    console.error(`MISSING PUBLIC DTS DEPENDENCY: ${relative(resolve(scriptDir, ".."), dtsPath)}`);
    missing += 1;
    continue;
  }
  declarationPaths.add(dtsPath);
  const dtsContent = readFileSync(dtsPath, "utf8");
  if (FORBIDDEN_PUBLIC_PROTOCOL_REGISTRY_RE.test(dtsContent)) {
    console.error(
      `FORBIDDEN PUBLIC DTS REGISTRY: ${relative(resolve(scriptDir, ".."), dtsPath)} retains ProtocolSchemas`,
    );
    missing += 1;
  }
  for (const match of dtsContent.matchAll(RELATIVE_DECLARATION_SPECIFIER_RE)) {
    const specifier = match[1];
    if (!specifier?.startsWith(".")) {
      continue;
    }
    const declarationSpecifier = specifier.endsWith(".js")
      ? `${specifier.slice(0, -3)}.d.ts`
      : `${specifier}.d.ts`;
    const importedPath = resolve(dirname(dtsPath), declarationSpecifier);
    if (importedPath.startsWith(`${distDir}${sep}`)) {
      declarationQueue.push(importedPath);
    }
  }
  for (const specifier of forbiddenPublicDeclarationSpecifiers) {
    if (dtsContent.includes(`"${specifier}`) || dtsContent.includes(`'${specifier}`)) {
      console.error(
        `FORBIDDEN PUBLIC DTS SPECIFIER: ${relative(resolve(scriptDir, ".."), dtsPath)} imports ${specifier}`,
      );
      missing += 1;
    }
  }
}

const declarationBytes = Array.from(declarationPaths).reduce<number>(
  (total, dtsPath) => total + statSync(dtsPath).size,
  0,
);
const declarationBudget = evaluatePluginSdkDeclarationBudget({
  buildPrivateQa: isPrivateQaPluginSdkBuild(process.env),
  declarationBytes,
});
if (declarationBudget.shouldFail) {
  const budgetLabel =
    declarationBudget.budgetKind === "private-qa-public-entry"
      ? "PRIVATE QA PUBLIC-ENTRY PLUGIN SDK"
      : "PLUGIN SDK";
  console.error(
    `${budgetLabel} DTS TOO LARGE: ${declarationBytes} bytes exceeds ${declarationBudget.budgetBytes} bytes.`,
  );
  console.error(
    `Budget: ${declarationBudget.ratchetBytes}-byte ratchet + ${declarationBudget.varianceBytes}-byte Rolldown output variance.`,
  );
  console.error("Keep plugin SDK declarations in the canonical unified tsdown graph.");
  missing += 1;
} else if (declarationBudget.budgetKind === "private-qa-public-entry") {
  console.log(
    `Private QA build public-entry declaration graph: ${declarationBytes}/${declarationBudget.budgetBytes} bytes (${MAX_PRIVATE_QA_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES}-byte ratchet + ${PLUGIN_SDK_DECLARATION_OUTPUT_VARIANCE_BYTES}-byte output variance); publication ratchet ${MAX_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES} bytes is not applied.`,
  );
} else {
  console.log(
    `Public plugin SDK declaration graph: ${declarationBytes}/${declarationBudget.budgetBytes} bytes (${MAX_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES}-byte ratchet + ${PLUGIN_SDK_DECLARATION_OUTPUT_VARIANCE_BYTES}-byte output variance).`,
  );
}

if (missing > 0) {
  console.error(`\nERROR: ${missing} plugin-sdk artifact check(s) failed.`);
  console.error("This will break published plugin-sdk artifacts.");
  console.error("Check generated d.ts rewrites, subpath entries, type compatibility, and rebuild.");
  process.exit(1);
}

console.log(`OK: All ${publicPluginSdkSubpaths.length} public plugin-sdk subpaths verified.`);
