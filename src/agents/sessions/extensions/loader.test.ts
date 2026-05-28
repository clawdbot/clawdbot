import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadExtensions } from "./loader.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("loadExtensions", () => {
  it("resolves the generic LLM plugin SDK subpath in jiti-loaded extensions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openclaw-extension-sdk-"));
    tempDirs.push(dir);
    const extensionPath = join(dir, "extension.ts");
    await writeFile(
      extensionPath,
      `
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";

export default async function(api) {
  const stream = createAssistantMessageEventStream();
  if (!stream || typeof stream.result !== "function") {
    throw new Error("generic LLM helper unavailable");
  }
  api.registerCommand("sdk-subpath-probe", {
    description: "probe",
    handler() {},
  });
}
`,
    );

    const result = await loadExtensions([extensionPath], dir);

    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0]?.commands.has("sdk-subpath-probe")).toBe(true);
  });

  it("resolves generic plugin SDK subpaths through the shared plugin loader aliases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openclaw-extension-sdk-"));
    tempDirs.push(dir);
    const extensionPath = join(dir, "extension.ts");
    await writeFile(
      extensionPath,
      `
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { defineTool } from "@openclaw/plugin-sdk/agent-sessions";

export default async function(api) {
  if (normalizeLowercaseStringOrEmpty("  MIXED  ") !== "mixed") {
    throw new Error("generic sdk subpath unavailable");
  }
  const tool = defineTool({
    name: "shared-sdk-probe",
    description: "probe",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
  api.registerTool(tool);
}
`,
    );

    const result = await loadExtensions([extensionPath], dir);

    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0]?.tools.has("shared-sdk-probe")).toBe(true);
  });
});
