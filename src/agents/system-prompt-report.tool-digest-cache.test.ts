// Guards the per-tool summary digest cache against the identity trap that made
// its predecessor unreachable: finalizeAgentTools rebuilds every tool object on
// every attempt, so a cache keyed on the tool cannot carry a digest forward.
// Isolated in its own file because the caches under test are module-level.
import { describe, expect, it, vi } from "vitest";

const { createHashCalls } = vi.hoisted(() => ({ createHashCalls: { count: 0 } }));

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return {
    ...actual,
    createHash: (...args: Parameters<typeof actual.createHash>) => {
      createHashCalls.count += 1;
      return actual.createHash(...args);
    },
  };
});

const { buildSystemPromptReport } = await import("./system-prompt-report.js");

describe("tool summary digest cache", () => {
  // The parameters object identity is stable across rebuilds (schema
  // normalization memoizes on it), which is why only the summary digest is at
  // stake here; keep these shared between the two tool sets.
  const parameters = [
    { type: "object", properties: { path: { type: "string" } } },
    { type: "object", properties: { pattern: { type: "string" } } },
    { type: "object", properties: { command: { type: "string" } } },
  ];
  const descriptions = [
    "tool-digest-cache probe: read a file from disk",
    "tool-digest-cache probe: search file contents",
    "tool-digest-cache probe: run a shell command",
  ];
  const makeTools = () =>
    descriptions.map((description, index) => ({
      name: `probe_${index}`,
      description,
      parameters: parameters[index],
    })) as never;

  const buildReport = (promptSuffix: string) =>
    buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: `tool-digest-cache system prompt ${promptSuffix}`,
      bootstrapFiles: [],
      injectedFiles: [],
      skillsPrompt: `<skill><name>digest-probe-${promptSuffix}</name></skill>`,
      tools: makeTools(),
    });

  it("does not rehash unchanged tool summaries when the tool objects are rebuilt", () => {
    const first = buildReport("a");
    // 1 system prompt + 1 skills prompt + 3 summaries + 3 schemas.
    expect(createHashCalls.count).toBe(8);

    createHashCalls.count = 0;
    const second = buildReport("b");

    // Structurally identical but distinct tool objects: the schema stats cache
    // hits on the shared parameters identity, and the summary digests must come
    // from the content-keyed cache. Only the two prompt digests remain.
    expect(createHashCalls.count).toBe(2);
    expect(second.tools.entries.map((entry) => entry.summaryHash)).toEqual(
      first.tools.entries.map((entry) => entry.summaryHash),
    );
    expect(second.tools.entries.map((entry) => entry.schemaHash)).toEqual(
      first.tools.entries.map((entry) => entry.schemaHash),
    );
  });
});
