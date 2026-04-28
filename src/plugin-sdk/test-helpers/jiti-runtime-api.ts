import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const JITI_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".mtsx",
  ".ctsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
] as const;

const PLUGIN_SDK_SPECIFIER_PREFIX = "openclaw/plugin-sdk/";
const SOURCE_MODULE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;

type SourceModuleRef = {
  specifier: string;
  typeOnly: boolean;
};

function listPluginSdkExportedSubpaths(root: string): string[] {
  const packageJsonPath = path.join(root, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    exports?: Record<string, unknown>;
  };
  return Object.keys(packageJson.exports ?? {})
    .filter((key) => key.startsWith("./plugin-sdk/"))
    .map((key) => key.slice("./plugin-sdk/".length));
}

function resolvePluginSdkAliasTarget(root: string, subpath: string): string | null {
  const distCandidate = path.join(root, "dist", "plugin-sdk", `${subpath}.js`);
  if (existsSync(distCandidate)) {
    return distCandidate;
  }

  for (const ext of SOURCE_MODULE_EXTENSIONS) {
    const srcCandidate = path.join(root, "src", "plugin-sdk", `${subpath}${ext}`);
    if (existsSync(srcCandidate)) {
      return srcCandidate;
    }
  }

  return null;
}

function resolveLocalModulePath(filePath: string, specifier: string): string | null {
  const basePath = path.resolve(path.dirname(filePath), specifier);
  const candidates = new Set<string>([basePath]);

  for (const ext of SOURCE_MODULE_EXTENSIONS) {
    candidates.add(`${basePath}${ext}`);
  }

  if (/\.[cm]?[jt]sx?$/u.test(basePath)) {
    const withoutExt = basePath.replace(/\.[cm]?[jt]sx?$/u, "");
    for (const ext of SOURCE_MODULE_EXTENSIONS) {
      candidates.add(`${withoutExt}${ext}`);
    }
  }

  for (const ext of SOURCE_MODULE_EXTENSIONS) {
    candidates.add(path.join(basePath, `index${ext}`));
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function collectSourceModuleRefs(filePath: string): SourceModuleRef[] {
  const sourceText = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const refs: SourceModuleRef[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier =
        statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : undefined;
      if (specifier) {
        refs.push({
          specifier,
          typeOnly: Boolean(statement.importClause?.isTypeOnly),
        });
      }
      continue;
    }

    if (!ts.isExportDeclaration(statement)) {
      continue;
    }

    const specifier =
      statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : undefined;
    if (!specifier) {
      continue;
    }

    const typeOnly = Boolean(
      statement.isTypeOnly ||
      (statement.exportClause &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.length > 0 &&
        statement.exportClause.elements.every((element) => element.isTypeOnly)),
    );

    refs.push({ specifier, typeOnly });
  }

  return refs;
}

function collectPluginSdkAliases(params: {
  modulePath: string;
  root: string;
  realPluginSdkSpecifiers?: readonly string[];
}): Record<string, string> {
  const realSpecifiers = new Set<string>();
  const stubSpecifiers = new Set<string>();
  const visitedFiles = new Set<string>();
  const stubPath = path.join(params.root, "test", "helpers", "plugins", "plugin-sdk-stub.cjs");
  const explicitRealSpecifiers = new Set(params.realPluginSdkSpecifiers ?? []);

  function visitModule(filePath: string, rootModule: boolean): void {
    if (visitedFiles.has(filePath)) {
      return;
    }
    visitedFiles.add(filePath);

    for (const ref of collectSourceModuleRefs(filePath)) {
      if (ref.specifier.startsWith(PLUGIN_SDK_SPECIFIER_PREFIX)) {
        const shouldKeepReal =
          rootModule &&
          !ref.typeOnly &&
          (explicitRealSpecifiers.size === 0 || explicitRealSpecifiers.has(ref.specifier));
        if (shouldKeepReal) {
          realSpecifiers.add(ref.specifier);
          const subpath = ref.specifier.slice(PLUGIN_SDK_SPECIFIER_PREFIX.length);
          const target = resolvePluginSdkAliasTarget(params.root, subpath);
          if (target?.endsWith(".ts")) {
            visitModule(target, false);
          }
        } else {
          stubSpecifiers.add(ref.specifier);
        }
        continue;
      }

      if (!ref.specifier.startsWith(".")) {
        continue;
      }

      const resolved = resolveLocalModulePath(filePath, ref.specifier);
      if (resolved) {
        visitModule(resolved, false);
      }
    }
  }

  visitModule(params.modulePath, true);

  const aliasEntries = new Map<string, string>();
  for (const specifier of listPluginSdkExportedSubpaths(params.root).map(
    (subpath) => `${PLUGIN_SDK_SPECIFIER_PREFIX}${subpath}`,
  )) {
    if (realSpecifiers.has(specifier)) {
      const subpath = specifier.slice(PLUGIN_SDK_SPECIFIER_PREFIX.length);
      aliasEntries.set(specifier, resolvePluginSdkAliasTarget(params.root, subpath) ?? stubPath);
      continue;
    }
    if (stubSpecifiers.has(specifier)) {
      aliasEntries.set(specifier, stubPath);
    }
  }

  return Object.fromEntries(aliasEntries);
}

export function loadRuntimeApiExportTypesViaJiti(params: {
  modulePath: string;
  exportNames: readonly string[];
  additionalAliases?: Record<string, string>;
  realPluginSdkSpecifiers?: readonly string[];
}): Record<string, string> {
  const root = process.cwd();
  const alias = {
    ...collectPluginSdkAliases({
      modulePath: params.modulePath,
      root,
      realPluginSdkSpecifiers: params.realPluginSdkSpecifiers,
    }),
    ...params.additionalAliases,
  };

  const script = `
import path from "node:path";
import { createJiti } from "jiti";

const modulePath = ${JSON.stringify(params.modulePath)};
const exportNames = ${JSON.stringify(params.exportNames)};
const alias = ${JSON.stringify(alias)};
const jiti = createJiti(path.join(${JSON.stringify(root)}, "openclaw.mjs"), {
  interopDefault: true,
  tryNative: false,
  fsCache: false,
  moduleCache: false,
  extensions: ${JSON.stringify(JITI_EXTENSIONS)},
  alias,
});
const mod = jiti(modulePath);
console.log(
  JSON.stringify(
    Object.fromEntries(exportNames.map((name) => [name, typeof mod[name]])),
  ),
);
`;

  const raw = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: root,
    encoding: "utf-8",
  });

  return JSON.parse(raw) as Record<string, string>;
}
