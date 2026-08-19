import fs from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { listGitTrackedFiles } from "../../test-utils/repo-files.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const THIS_TEST_FILE = "src/plugins/contracts/extension-test-api-consumption.test.ts";

type ExtensionTestApi = {
  absoluteStem: string;
  packageName?: string;
  packageExportsTestApi: boolean;
  pluginId: string;
  repoPath: string;
};

function listTrackedFiles(pathspecs: string | readonly string[]): string[] {
  const files = listGitTrackedFiles({ pathspecs, repoRoot: REPO_ROOT });
  if (!files) {
    throw new Error(`failed to list tracked files for ${JSON.stringify(pathspecs)}`);
  }
  return files;
}

function stripModuleExtension(value: string): string {
  return value.replace(/\.(?:[cm]?[jt]sx?)$/u, "");
}

function listExtensionTestApis(): ExtensionTestApi[] {
  return listTrackedFiles("extensions/*/test-api.ts").map((repoPath) => {
    const pluginId = repoPath.split("/")[1];
    if (!pluginId) {
      throw new Error(`invalid extension test API path: ${repoPath}`);
    }
    const packageJsonPath = resolve(REPO_ROOT, "extensions", pluginId, "package.json");
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      exports?: Record<string, unknown>;
      name?: unknown;
    };
    const packageName = typeof parsed.name === "string" ? parsed.name : undefined;
    const packageExportsTestApi = Object.keys(parsed.exports ?? {}).some(
      (key) => stripModuleExtension(key) === "./test-api",
    );
    return {
      absoluteStem: stripModuleExtension(resolve(REPO_ROOT, repoPath)),
      packageName,
      packageExportsTestApi,
      pluginId,
      repoPath,
    };
  });
}

function objectStringProperty(node: ts.ObjectLiteralExpression, name: string): string | undefined {
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const propertyName = ts.isIdentifier(property.name)
      ? property.name.text
      : ts.isStringLiteralLike(property.name)
        ? property.name.text
        : undefined;
    if (propertyName === name && ts.isStringLiteralLike(property.initializer)) {
      return property.initializer.text;
    }
  }
  return undefined;
}

function collectTestApiSourceReferences(source: string, fileName = "source.ts") {
  const moduleSpecifiers = ts
    .preProcessFile(source, true, true)
    .importedFiles.map((entry) => entry.fileName)
    .toSorted();
  const pluginIds = new Set<string>();
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const name = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : undefined;
      const pluginId = node.arguments[0];
      if (
        name === "loadQaRunnerBundledPluginTestApi" &&
        pluginId &&
        ts.isStringLiteralLike(pluginId)
      ) {
        pluginIds.add(pluginId.text);
      }
    } else if (ts.isObjectLiteralExpression(node)) {
      const pluginId = objectStringProperty(node, "pluginId");
      if (pluginId && objectStringProperty(node, "artifactBasename") === "test-api.js") {
        pluginIds.add(pluginId);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { moduleSpecifiers, pluginIds: [...pluginIds].toSorted() };
}

function resolveTestApiPluginId(
  specifier: string,
  importerFile: string,
  testApis: readonly ExtensionTestApi[],
): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const resolvedStem = stripModuleExtension(resolve(dirname(importerFile), specifier));
    return testApis.find((testApi) => testApi.absoluteStem === resolvedStem)?.pluginId;
  }
  const bareSpecifier = stripModuleExtension(specifier);
  return testApis.find(
    (testApi) => testApi.packageName && `${testApi.packageName}/test-api` === bareSpecifier,
  )?.pluginId;
}

function collectOrphanExtensionTestApiFiles(): string[] {
  const testApis = listExtensionTestApis();
  const consumed = new Set(
    testApis.filter((testApi) => testApi.packageExportsTestApi).map((testApi) => testApi.pluginId),
  );
  const testApiFiles = new Set(testApis.map((testApi) => testApi.repoPath));

  for (const repoPath of listTrackedFiles(["src", "test", "extensions", "packages", "scripts"])) {
    if (
      repoPath === THIS_TEST_FILE ||
      testApiFiles.has(repoPath) ||
      !/\.(?:[cm]?[jt]sx?)$/u.test(repoPath)
    ) {
      continue;
    }
    const absolutePath = resolve(REPO_ROOT, repoPath);
    const source = fs.readFileSync(absolutePath, "utf8");
    if (!source.includes("test-api") && !source.includes("loadQaRunnerBundledPluginTestApi")) {
      continue;
    }
    const references = collectTestApiSourceReferences(source, absolutePath);
    for (const pluginId of references.pluginIds) {
      if (testApis.some((testApi) => testApi.pluginId === pluginId)) {
        consumed.add(pluginId);
      }
    }
    for (const specifier of references.moduleSpecifiers) {
      const pluginId = resolveTestApiPluginId(specifier, absolutePath, testApis);
      if (pluginId) {
        consumed.add(pluginId);
      }
    }
  }

  return testApis
    .filter((testApi) => !consumed.has(testApi.pluginId))
    .map((testApi) => testApi.repoPath)
    .toSorted();
}

describe("extension test API consumption", () => {
  it("ignores identifier text and generic loader implementations", () => {
    expect(
      collectTestApiSourceReferences(`
        const testing = {};
        function loadQaRunnerBundledPluginTestApi(pluginId: string) {
          return load({ pluginId, artifactBasename: "test-api.js" });
        }
      `),
    ).toStrictEqual({ moduleSpecifiers: [], pluginIds: [] });
  });

  it("collects real module edges and literal plugin loaders", () => {
    expect(
      collectTestApiSourceReferences(`
        import { testing } from "@openclaw/example/test-api.js";
        export { helper } from "../test-api.js";
        type TestApi = typeof import("./test-api.js");
        loadQaRunnerBundledPluginTestApi("matrix");
        loadBundledPluginPublicSurface({ pluginId: "codex", artifactBasename: "test-api.js" });
      `),
    ).toStrictEqual({
      moduleSpecifiers: ["../test-api.js", "./test-api.js", "@openclaw/example/test-api.js"],
      pluginIds: ["codex", "matrix"],
    });
  });

  it(
    "keeps only consumed extension test APIs",
    () => expect(collectOrphanExtensionTestApiFiles()).toStrictEqual([]),
    240_000,
  );
});
