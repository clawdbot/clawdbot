import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import {
  formatCliProcessFailure,
  runCliProcessChild,
} from "../cli/cli-process-child.test-helpers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

it("projects MCP App metadata without loading session runtime management", async () => {
  await withOpenClawTestState({ label: "mcp-app-import", applyEnv: false }, async (state) => {
    const entry = state.path("app-import.mjs");
    const temporaryDir = state.path("tmp");
    await fs.mkdir(temporaryDir);
    await state.writeConfig({ logging: { file: state.path("runtime.log") } });
    await fs.writeFile(
      entry,
      `import assert from "node:assert/strict";
import { registerHooks } from "node:module";
assert.equal(process.env.VITEST, undefined);
assert.equal(process.env.NODE_ENV, undefined);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/agent-bundle-mcp-(?:runtime|manager(?:-api)?)\\.[jt]s(?:[?#]|$)/.test(specifier)) {
      throw new Error("MCP App metadata imported runtime management: " + specifier + " from " + context.parentURL);
    }
    return nextResolve(specifier, context);
  },
});
const { buildMcpAppCanvasPayload, readMcpAppChannelView } = await import(${JSON.stringify(pathToFileURL(path.resolve("src/agents/mcp-ui-resource.ts")).href)});
const preview = buildMcpAppCanvasPayload({
  viewId: "mcp-app-fixture", title: "Fixture", serverName: "fixture", toolName: "show", uiResourceUri: "ui://fixture/app",
});
assert.equal(preview.kind, "canvas");
assert.deepEqual(readMcpAppChannelView({ details: { mcpAppPreview: preview } }), { viewId: "mcp-app-fixture" });
console.log("mcp-app-import-boundary-ok");
`,
    );
    const result = await runCliProcessChild({
      nodeArgs: ["--import", "tsx", entry],
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        ...state.envVars,
        TMPDIR: temporaryDir,
        TMP: temporaryDir,
        TEMP: temporaryDir,
      },
      timeoutMs: 30_000,
    });
    expect(
      result.code,
      formatCliProcessFailure({ reason: "MCP App cold import failed", ...result }),
    ).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain("mcp-app-import-boundary-ok");
  });
});
