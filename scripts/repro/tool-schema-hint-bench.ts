#!/usr/bin/env -S node --import tsx
// Micro-benchmark for the Code Mode catalog hot path: schema hint compaction,
// full-catalog quick-index assembly, and declared-output validation. These run
// per agent run attempt, so regressions here tax every Code Mode turn.
import { performance } from "node:perf_hooks";
import { Type } from "typebox";
import { applyCodeModeCatalog, createCodeModeTools } from "../../src/agents/code-mode.js";
import { compactToolInputHint, compactToolOutputHint } from "../../src/agents/tool-schema-hints.js";
import {
  compactToolSearchCatalogEntry,
  createToolSearchCatalogRef,
} from "../../src/agents/tool-search.js";
import { jsonResult, type AnyAgentTool } from "../../src/agents/tools/common.js";
import { validateJsonSchemaValue } from "../../src/plugins/schema-validator.js";
import { setPluginToolMeta } from "../../src/plugins/tools.js";

const WARMUP_ITERATIONS = 50;
const BATCHES = 7;
const CATALOG_TOOL_COUNT = 72;

const TypicalInputSchema = Type.Object({
  channel: Type.Optional(Type.String({ minLength: 1 })),
  query: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
});

const TypicalOutputSchema = Type.Union([
  Type.Object(
    {
      status: Type.Literal("replied"),
      messageId: Type.String(),
      reply: Type.Object(
        {
          text: Type.String(),
          timestamp: Type.Number(),
          threadId: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { status: Type.Literal("timeout"), messageId: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    { status: Type.Literal("error"), error: Type.String() },
    { additionalProperties: false },
  ),
]);

const TypicalOutputValue = {
  status: "replied",
  messageId: "m-1",
  reply: { text: "done", timestamp: 1_700_000_000_000, threadId: "t-9" },
};

function buildAdversarialSchema(): Record<string, unknown> {
  // Attacker-sized MCP metadata: wide property map, deep nesting, giant enum.
  const wide: Record<string, unknown> = {};
  for (let index = 0; index < 5_000; index += 1) {
    wide[`property_${index}_${"x".repeat(24)}`] = { type: "string" };
  }
  let deep: Record<string, unknown> = { type: "string" };
  for (let index = 0; index < 40; index += 1) {
    deep = { type: "object", properties: { child: deep } };
  }
  return {
    type: "object",
    properties: {
      ...wide,
      deep,
      bigEnum: { enum: Array.from({ length: 10_000 }, (_unused, index) => `value-${index}`) },
    },
  };
}

function buildCatalogTools(): AnyAgentTool[] {
  const tools: AnyAgentTool[] = [];
  for (let index = 0; index < CATALOG_TOOL_COUNT; index += 1) {
    const declareOutput = index % 3 === 0;
    const name = `bench_tool_${String(index).padStart(2, "0")}`;
    const tool = {
      name,
      label: name,
      description: `Benchmark tool ${index} exercising catalog compaction cost.`,
      parameters: TypicalInputSchema,
      ...(declareOutput ? { outputSchema: TypicalOutputSchema } : {}),
      execute: async (_toolCallId: string, _params: unknown) => jsonResult({ ok: true }),
    } satisfies AnyAgentTool;
    setPluginToolMeta(tool, { pluginId: "bench-hints", optional: true });
    tools.push(tool);
  }
  return tools;
}

const CODE_MODE_SESSION = {
  sessionId: "bench-hints",
  sessionKey: "agent:bench-hints:main",
  agentId: "bench",
  runId: "run-bench-hints",
};
const CODE_MODE_CONFIG = { tools: { codeMode: { enabled: true, timeoutMs: 20_000 } } };

function applyCodeModeSurface(tools: AnyAgentTool[]) {
  const catalogRef = createToolSearchCatalogRef();
  const codeModeTools = createCodeModeTools({
    config: CODE_MODE_CONFIG,
    runtimeConfig: CODE_MODE_CONFIG,
    ...CODE_MODE_SESSION,
    catalogRef,
  });
  return {
    catalogRef,
    applied: applyCodeModeCatalog({
      tools: [...codeModeTools, ...tools],
      config: CODE_MODE_CONFIG,
      ...CODE_MODE_SESSION,
      catalogRef,
    }),
  };
}

type BenchCase = { name: string; iterations: number; run: () => void };

function median(values: number[]): number {
  const sorted = [...values].toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function bench(benchCase: BenchCase): { name: string; nsPerOp: number; opsPerSec: number } {
  for (let index = 0; index < WARMUP_ITERATIONS; index += 1) {
    benchCase.run();
  }
  const perBatchNs: number[] = [];
  for (let batch = 0; batch < BATCHES; batch += 1) {
    const start = performance.now();
    for (let index = 0; index < benchCase.iterations; index += 1) {
      benchCase.run();
    }
    perBatchNs.push(((performance.now() - start) * 1e6) / benchCase.iterations);
  }
  const nsPerOp = median(perBatchNs);
  return { name: benchCase.name, nsPerOp, opsPerSec: 1e9 / nsPerOp };
}

async function main(): Promise<void> {
  const adversarial = buildAdversarialSchema();
  const tools = buildCatalogTools();
  const { catalogRef, applied } = applyCodeModeSurface(tools);
  const entries = catalogRef.current?.entries ?? [];
  if (entries.length < CATALOG_TOOL_COUNT) {
    throw new Error(`catalog only registered ${entries.length} entries`);
  }
  // Warm the validator cache once so the loop measures the steady-state hit.
  validateJsonSchemaValue({
    schema: TypicalOutputSchema as never,
    cacheKey: "bench:typical-output",
    value: TypicalOutputValue,
  });

  const cases: BenchCase[] = [
    {
      name: "hint: typical input",
      iterations: 20_000,
      run: () => void compactToolInputHint(TypicalInputSchema),
    },
    {
      name: "hint: typical output union",
      iterations: 20_000,
      run: () => void compactToolOutputHint(TypicalOutputSchema),
    },
    {
      name: "hint: adversarial 5k-prop schema",
      iterations: 200,
      run: () => void compactToolInputHint(adversarial),
    },
    {
      name: `catalog: compact ${CATALOG_TOOL_COUNT} entries`,
      iterations: 2_000,
      run: () => {
        for (const entry of entries) {
          compactToolSearchCatalogEntry(entry);
        }
      },
    },
    {
      name: "validate: declared output warm hit",
      iterations: 20_000,
      run: () =>
        void validateJsonSchemaValue({
          schema: TypicalOutputSchema as never,
          cacheKey: "bench:typical-output",
          value: TypicalOutputValue,
        }),
    },
    {
      name: "surface: full applyCodeModeCatalog",
      iterations: 500,
      run: () => void applyCodeModeSurface(tools),
    },
  ];

  process.stdout.write(
    `tool-schema-hint-bench catalogTools=${entries.length} visibleTools=${applied.tools.length}\n`,
  );
  for (const benchCase of cases) {
    const result = bench(benchCase);
    const usPerOp = (result.nsPerOp / 1_000).toFixed(2);
    const ops = Math.round(result.opsPerSec).toLocaleString("en-US");
    process.stdout.write(
      `${result.name.padEnd(36)} ${usPerOp.padStart(10)} us/op ${ops.padStart(12)} ops/s\n`,
    );
  }
}

await main();
