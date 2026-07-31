// Builds the reusable AI package separately to keep provider bundling out of
// the already-parallel main package graph.
import type { UserConfig } from "tsdown";

const externalDependencies = [
  "@anthropic-ai/sdk",
  "@google/genai",
  "@mistralai/mistralai",
  "openai",
  "typebox",
] as const;

const config = {
  clean: true,
  dts: process.env.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD !== "1",
  entry: {
    index: "packages/ai/src/index.ts",
    providers: "packages/ai/src/providers.ts",
    transports: "packages/ai/src/transports.ts",
    diagnostics: "packages/ai/src/utils/diagnostics.ts",
    "event-stream": "packages/ai/src/utils/event-stream.ts",
    types: "packages/ai/src/types.ts",
    validation: "packages/ai/src/validation.ts",
    "internal/anthropic": "packages/ai/src/internal/anthropic.ts",
    "internal/openai": "packages/ai/src/internal/openai.ts",
    "internal/retry-after": "packages/ai/src/internal/retry-after.ts",
    "internal/runtime": "packages/ai/src/internal/runtime.ts",
    "internal/shared": "packages/ai/src/internal/shared.ts",
  },
  env: { NODE_ENV: "production" },
  format: "esm",
  outDir: "packages/ai/dist",
  platform: "node",
  deps: {
    neverBundle(id) {
      return externalDependencies.some(
        (dependency) => id === dependency || id.startsWith(`${dependency}/`),
      );
    },
  },
} satisfies UserConfig;

export default config;
