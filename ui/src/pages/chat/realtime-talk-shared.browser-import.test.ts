// @vitest-environment node
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

function importLines(source: string): string[] {
  return source
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("import "))
    .map((line) => line.trim());
}

describe("realtime talk shared browser imports", () => {
  it("keeps embedded run-control runtime out of the Control UI import path", async () => {
    const source = await readFile(new URL("./realtime-talk-shared.ts", import.meta.url), "utf8");
    const imports = importLines(source);

    expect(imports).toContain(
      'import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "../../../../src/talk/agent-consult-tool.js";',
    );
    expect(source).toContain('from "../../../../src/talk/agent-run-control-shared.js";');
    expect(imports.some((line) => line.includes("agent-run-control.js"))).toBe(false);
  });
});
