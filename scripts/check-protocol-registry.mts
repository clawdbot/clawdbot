import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
const repoRoot = resolveRepoRoot(import.meta.url);
const schemaDir = path.join(repoRoot, "packages/gateway-protocol/src/schema");
const failures: string[] = [];
const read = (relativePath: string) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
const check = (condition: unknown, message: string) => {
  if (!condition) {
    failures.push(message);
  }
};
const getObjectExport = (module: unknown, binding: string) =>
  isRecord(module) && isRecord(module[binding]) ? module[binding] : undefined;

const registryPath = "packages/gateway-protocol/src/schema/protocol-schemas.ts";
const registrySource = read(registryPath);
const fragmentImports = [
  ...registrySource.matchAll(
    /^import \{ ([A-Za-z0-9_]+) \} from "(\.\/protocol-schema-fragment-[^"]+\.js)";$/gmu,
  ),
].map(([, binding = "", specifier = ""]) => ({ binding, specifier }));
const importSpecifiers = [...registrySource.matchAll(/^import .* from "([^"]+)";$/gmu)].map(
  ([, specifier = ""]) => specifier,
);
check(
  importSpecifiers.every(
    (specifier) =>
      specifier === "./protocol-schema-composer.js" ||
      specifier.startsWith("./protocol-schema-fragment-"),
  ),
  `${registryPath} may import only the composer and schema fragments`,
);
check(
  !/\b[A-Z][A-Za-z0-9]*Schema\b/u.test(registrySource),
  `${registryPath} contains a direct *Schema inventory`,
);

const composition = registrySource.match(
  /export const ProtocolSchemas:\s*([\s\S]*?)\s*= composeProtocolSchemaFragments\(\[([\s\S]*?)\]\s+as const\);/u,
);
const composedBindings = (composition?.[2] ?? "")
  .split("\n")
  .map((line) => line.trim().replace(/,$/u, ""))
  .filter(Boolean);
const annotatedBindings = (composition?.[1] ?? "")
  .split("&")
  .map((type) => /^typeof ([A-Za-z0-9_]+)$/u.exec(type.trim())?.[1]);
const importedBindings = fragmentImports.map(({ binding }) => binding);
check(
  Boolean(composition),
  `${registryPath} must explicitly type and compose an ordered fragment array`,
);
check(
  annotatedBindings.length === composedBindings.length &&
    annotatedBindings.every((binding, index) => binding === composedBindings[index]),
  `${registryPath} must annotate the composed fragments with their exact ordered typeof intersection`,
);
check(
  composedBindings.length === importedBindings.length &&
    new Set(composedBindings).size === composedBindings.length &&
    importedBindings.every((binding) => composedBindings.includes(binding)),
  `${registryPath} must compose every imported fragment exactly once`,
);

const fragmentFiles = fs
  .readdirSync(schemaDir)
  .filter((name) => /^protocol-schema-fragment-.+\.ts$/u.test(name));
const importedFiles = fragmentImports.map(({ specifier }) => `${specifier.slice(2, -3)}.ts`);
check(
  fragmentFiles.length === importedFiles.length &&
    fragmentFiles.every((name) => importedFiles.includes(name)),
  `${registryPath} must explicitly import every protocol schema fragment`,
);

const importsByBinding = new Map(
  fragmentImports.map((fragmentImport) => [fragmentImport.binding, fragmentImport]),
);
const seenKeys = new Set<string>();
const orderedKeys: string[] = [];
for (const binding of composedBindings) {
  const { specifier } = importsByBinding.get(binding) ?? {};
  if (!specifier) {
    continue;
  }
  const moduleUrl = new URL(specifier.replace(/\.js$/u, ".ts"), pathToFileURL(registryPath));
  const fragment = getObjectExport(await import(moduleUrl.href), binding);
  check(fragment, `${specifier} must export object ${binding}`);
  if (!fragment) {
    continue;
  }
  for (const key of Object.keys(fragment)) {
    check(!seenKeys.has(key), `duplicate protocol schema key ${key}`);
    seenKeys.add(key);
    orderedKeys.push(key);
  }
}
const { ProtocolSchemas } =
  await import("../packages/gateway-protocol/src/schema/protocol-schemas.ts");
check(
  JSON.stringify(Object.keys(ProtocolSchemas)) === JSON.stringify(orderedKeys),
  "ProtocolSchemas must preserve explicit fragment/key order",
);

const composerSource = read("packages/gateway-protocol/src/schema/protocol-schema-composer.ts");
check(!/\.(?:sort|toSorted)\s*\(/u.test(composerSource), "schema composer must not sort");
check(
  composerSource.includes("Object.hasOwn(registry, key)"),
  "schema composer must reject duplicate fragment keys",
);

const withoutComments = (source: string) =>
  source
    .replace(/\r\n?/gu, "\n")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/.*$/gmu, "")
    .trim();
const schemaModulesSource = withoutComments(
  read("packages/gateway-protocol/src/schema-modules.ts"),
);
const ownerModules = [
  ...schemaModulesSource.matchAll(/^export \* from "\.\/schema\/([^"]+)\.js";$/gmu),
].map(([, moduleName = ""]) => moduleName);
check(
  ownerModules.length === 64 && new Set(ownerModules).size === ownerModules.length,
  "schema-modules.ts must contain one unique 64-module owner list",
);
check(
  schemaModulesSource.split("\n").filter(Boolean).length === ownerModules.length,
  "schema-modules.ts may contain only owner-module exports",
);
check(
  withoutComments(read("packages/gateway-protocol/src/schema.ts")) ===
    'export * from "./schema-modules.js";\nexport * from "./schema/protocol-schemas.js";',
  "schema.ts must remain a schema-modules/protocol-schemas wrapper",
);
check(
  withoutComments(read("packages/gateway-protocol/src/schema-types.ts")) ===
    'export type * from "./schema-modules.js";',
  "schema-types.ts must remain a registry-free schema-modules wrapper",
);

const publicIndexSource = read("packages/gateway-protocol/src/index.ts");
const publicSchemaSource = read("packages/gateway-protocol/src/public-schema.ts");
check(
  publicIndexSource.includes('export * from "./public-schema.js";'),
  "index.ts must expose the reviewed public schema allowlist",
);
check(
  publicSchemaSource.includes('} from "./schema-modules.js";'),
  "public-schema.ts must explicitly export the reviewed public schema allowlist",
);
check(
  !publicSchemaSource.includes('export * from "./schema-modules.js";'),
  "public-schema.ts must not expose every schema module export implicitly",
);
check(
  !fs.existsSync(path.join(repoRoot, "packages/gateway-protocol/src/schema-export-registry.ts")),
  "the public schema allowlist must stay in its canonical public-schema owner",
);

for (const relativePath of [
  "packages/gateway-protocol/src/index.ts",
  "packages/gateway-protocol/src/public-schema.ts",
  "packages/gateway-protocol/src/validator-registry.ts",
]) {
  check(
    !read(relativePath).includes('from "./schema.js"'),
    `${relativePath} must not cross the registry through schema.ts`,
  );
}
const pluginSdkGuard = read("scripts/check-plugin-sdk-exports.mts");
check(
  pluginSdkGuard.includes("FORBIDDEN_PUBLIC_PROTOCOL_REGISTRY_RE") &&
    pluginSdkGuard.includes("FORBIDDEN PUBLIC DTS REGISTRY"),
  "plugin SDK declaration checks must reject leaked ProtocolSchemas declarations",
);

if (failures.length) {
  throw new Error(
    failures.map((failure) => `protocol registry check failed: ${failure}`).join("\n"),
  );
}
console.log("protocol registry check passed");
