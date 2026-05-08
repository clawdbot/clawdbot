import path from "node:path";
import { describe, expect, it } from "vitest";
import { withPathResolutionEnv } from "../test-utils/env.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import { formatPluginSourceForTable, resolvePluginSourceRoots } from "./source-display.js";

const PLUGIN_SOURCE_ROOTS = {
  stock: path.resolve(path.sep, "opt", "homebrew", "lib", "node_modules", "openclaw", "extensions"),
  global: path.resolve(path.sep, "Users", "x", ".openclaw", "extensions"),
  workspace: path.resolve(path.sep, "Users", "x", "ws", ".openclaw", "extensions"),
};

function expectFormattedSource(params: {
  origin: "bundled" | "workspace" | "global";
  sourceKey: "stock" | "workspace" | "global";
  dirName: string;
  fileName: string;
  expectedValue: string;
  expectedRootKey: "stock" | "workspace" | "global";
}) {
  const out = formatPluginSourceForTable(
    {
      origin: params.origin,
      source: path.join(PLUGIN_SOURCE_ROOTS[params.sourceKey], params.dirName, params.fileName),
    },
    PLUGIN_SOURCE_ROOTS,
  );
  expect(out.value).toBe(params.expectedValue);
  expect(out.rootKey).toBe(params.expectedRootKey);
}

function expectFormattedSourceCase(params: ReturnType<typeof createFormattedSourceExpectation>) {
  expectFormattedSource(params);
}

function expectResolvedSourceRoots(params: {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  workspaceDir: string;
  expected: Record<"stock" | "global" | "workspace", string>;
}) {
  const roots = withPathResolutionEnv(params.homeDir, params.env, (env) =>
    resolvePluginSourceRoots({
      env,
      workspaceDir: params.workspaceDir,
    }),
  );

  expect(roots).toEqual(params.expected);
}

function createFormattedSourceExpectation(
  origin: "bundled" | "workspace" | "global",
  sourceKey: "stock" | "workspace" | "global",
  dirName: string,
  fileName: string,
) {
  return {
    origin,
    sourceKey,
    dirName,
    fileName,
    expectedValue: `${origin === "bundled" ? "stock" : origin}:${dirName}/${fileName}`,
    expectedRootKey: sourceKey,
  } as const;
}

describe("formatPluginSourceForTable", () => {
  it.each([
    createFormattedSourceExpectation("bundled", "stock", "demo-stock", "index.ts"),
    createFormattedSourceExpectation("workspace", "workspace", "demo-workspace", "index.ts"),
    createFormattedSourceExpectation("global", "global", "demo-global", "index.js"),
  ])("shortens $origin sources under the $sourceKey root", expectFormattedSourceCase);

  it("ignores untrusted explicit env override for the stock source root", () => {
    const homeDir = path.resolve(path.sep, "tmp", "openclaw-home");
    const rawEnv = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: "~/bundled",
      OPENCLAW_STATE_DIR: "~/state",
    } as NodeJS.ProcessEnv;
    const stock = withPathResolutionEnv(homeDir, rawEnv, (env) => resolveBundledPluginsDir(env));
    if (!stock) {
      throw new Error("expected bundled plugin source root");
    }
    expectResolvedSourceRoots({
      homeDir,
      env: rawEnv,
      workspaceDir: "~/ws",
      expected: {
        stock,
        global: path.join(homeDir, "state", "extensions"),
        workspace: path.join(homeDir, "ws", ".openclaw", "extensions"),
      },
    });
  });
});
