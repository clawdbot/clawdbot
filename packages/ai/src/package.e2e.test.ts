import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveNpmRunner } from "../../../scripts/npm-runner.mts";
import { createNodeEvalArgs } from "../../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";

type CommandResult = { stdout: string; stderr: string };
type PackageManifest = {
  name: string;
  version: string;
  exports: Record<string, unknown>;
};

const COMMAND_TIMEOUT_MS = 180_000;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const compatibility = {
  "@openclaw/ai/providers": {
    values: [
      "BUILT_IN_API_PROVIDER_SOURCE_ID",
      "registerBuiltInApiProviders",
      "resetApiProviders",
      "OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH",
      "clampOpenAIPromptCacheKey",
    ],
    types: [],
  },
  "@openclaw/ai/internal/anthropic": {
    values: [
      "streamAnthropic",
      "streamSimpleAnthropic",
      "usesFoundryBearerAuth",
      "omitFoundryBearerCredentialHeaders",
      "requiresClaudeDefaultSampling",
      "requiresClaudeMandatoryAdaptiveThinking",
      "resolveClaudeFable5ModelIdentity",
      "resolveClaudeModelIdentity",
      "resolveClaudeMythos5ModelIdentity",
      "resolveClaudeNativeThinkingLevelMap",
      "resolveClaudeOpus5ModelIdentity",
      "resolveClaudeSonnet5ModelIdentity",
      "supportsClaudeAdaptiveThinking",
      "supportsClaudeNativeMaxEffort",
      "supportsClaudeNativeXhighEffort",
      "usesClaudeFable5MessagesContract",
      "usesClaudeStreamingRefusalContract",
      "requiresClaudeAdaptiveThinking",
      "defaultsClaudeAdaptiveThinking",
      "prepareClaudeNoPrefillRequestContext",
      "applyClaudeRequestContract",
      "resolveModelBoundThinkingReplayMode",
      "applyAnthropicRefusal",
      "ANTHROPIC_SERVER_SIDE_FALLBACK_BETA",
      "ANTHROPIC_SERVER_SIDE_FALLBACKS",
      "CLAUDE_OPUS_FALLBACK_MODEL_COST",
      "resolveAnthropicFallbackServingModelCost",
      "readAnthropicFallbackBoundary",
      "applyAnthropicFallbackBoundary",
      "ANTHROPIC_OMITTED_REASONING_TEXT",
      "findActiveAnthropicToolTurnAssistantIndex",
      "projectAnthropicTools",
      "reconcileAnthropicToolChoice",
      "resolveOriginalAnthropicToolName",
      "readAnthropicUsageTokenCount",
      "readAnthropicCacheWriteUsage",
      "readAnthropicPromptUsageSnapshot",
      "readLastAnthropicIterationUsage",
    ],
    types: [
      "AnthropicEffort",
      "AnthropicThinkingDisplay",
      "AnthropicOptions",
      "AnthropicFallbackBoundary",
      "AnthropicToolProjection",
      "AnthropicProjectedToolChoice",
      "AnthropicCacheWriteUsage",
      "AnthropicPromptUsageSnapshot",
      "AnthropicIterationUsageSnapshot",
      "AnthropicIterationUsageResult",
    ],
  },
  "@openclaw/ai/internal/openai": {
    values: [
      "streamOpenAICompletions",
      "streamSimpleOpenAICompletions",
      "convertMessages",
      "extractToolSchemaModelCompat",
      "resolveUnsupportedToolSchemaKeywords",
      "shouldOmitEmptyArrayItems",
      "normalizeToolParameterSchema",
      "parseAzureDeploymentNameMap",
      "resolveAzureDeploymentNameFromMap",
      "isTraditionalAzureOpenAIHost",
      "isOpenAICompatibleAzureResponsesBaseUrl",
      "GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS",
      "cleanSchemaForGemini",
      "OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH",
      "clampOpenAIPromptCacheKey",
      "isOpenAIGpt54MiniModel",
      "isOpenAIGpt55Model",
      "isOpenAIGpt56Model",
      "normalizeOpenAIReasoningEffort",
      "resolveOpenAISupportedReasoningEfforts",
      "supportsOpenAITemperature",
      "supportsOpenAIReasoningEffort",
      "resolveOpenAIReasoningEffortForModel",
      "streamOpenAIResponses",
      "streamSimpleOpenAIResponses",
      "OPENAI_RESPONSES_OUTPUT_TEXT_CONTENT_PART_TYPE",
      "AZURE_RESPONSES_TEXT_CONTENT_PART_TYPE",
      "OPENAI_RESPONSES_OUTPUT_TEXT_DELTA_EVENT_TYPE",
      "AZURE_RESPONSES_TEXT_DELTA_EVENT_TYPE",
      "isResponsesTextContentPartType",
      "isResponsesTextDeltaEventType",
      "isAzureResponsesTextDeltaEventType",
      "isAzureResponsesTextDeltaEvent",
      "resolveResponsesMessageSnapshotCollapse",
      "mapResponsesTerminalUsage",
      "readResponsesReasoningTokens",
      "resolveResponsesTerminalStopReason",
      "readResponsesToolCallItemIdentity",
      "createResponsesToolCallTracker",
      "mapOpenAIStopReason",
      "projectOpenAITools",
      "reconcileOpenAIResponsesToolChoice",
      "reconcileOpenAICompletionsToolChoice",
      "findOpenAIStrictSchemaViolations",
      "normalizeOpenAIStrictCompatSchema",
      "normalizeStrictOpenAIJsonSchema",
      "normalizeOpenAIStrictToolParameters",
      "isStrictOpenAIJsonSchemaCompatible",
      "findOpenAIStrictToolProjectionDiagnostics",
      "resolveOpenAIProjectedToolsStrictToolFlag",
      "stripUnsupportedSchemaKeywords",
      "projectRuntimeToolInputSchema",
      "responsesPromptObserver",
    ],
    types: [
      "OpenAICompletionsOptions",
      "ToolSchemaModelCompat",
      "ToolParameterSchemaOptions",
      "OpenAIReasoningEffort",
      "OpenAIApiReasoningEffort",
      "OpenAIResponsesOptions",
      "ResponsesTextContentPartType",
      "ResponsesTextDeltaEventType",
      "AzureResponsesTextContentPart",
      "AzureResponsesTextDeltaEvent",
      "ResponsesMessageSnapshotCollapse",
      "ResponsesTerminalUsagePayload",
      "ResponsesToolCallIdentity",
      "ResponsesToolCallState",
      "OpenAIStopReasonResult",
      "OpenAIToolProjection",
      "OpenAICompletionsToolChoice",
      "RuntimeToolInputSchemaJson",
      "RuntimeToolInputSchemaProjection",
      "ResponsesPromptObservation",
    ],
  },
} as const;

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number } & Pick<
    SpawnOptionsWithoutStdio,
    "env" | "shell" | "windowsVerbatimArguments"
  >,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: options.env ?? process.env,
      shell: options.shell,
      stdio: ["ignore", "pipe", "pipe"],
      windowsVerbatimArguments: options.windowsVerbatimArguments,
    });
    const timer = setTimeout(() => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
      reject(new Error(`command timed out: ${[command, ...args].join(" ")}`));
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const result = { stdout: stdout.join(""), stderr: stderr.join("") };
      if (code === 0) {
        resolve(result);
      } else {
        reject(
          new Error(
            `command failed (${String(code ?? signal)}): ${[command, ...args].join(" ")}\n` +
              `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
          ),
        );
      }
    });
  });
}

function runNpmCommand(args: string[], cwd: string): Promise<CommandResult> {
  const env = {
    ...process.env,
    CI: process.env.CI ?? "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
  const runner = resolveNpmRunner({ env, npmArgs: args });
  return runCommand(runner.command, runner.args, {
    cwd,
    env: runner.env ?? env,
    shell: runner.shell,
    windowsVerbatimArguments: runner.windowsVerbatimArguments,
  });
}

function packageSpecifier(packageName: string, exportKey: string): string {
  return exportKey === "." ? packageName : `${packageName}/${exportKey.slice(2)}`;
}

function compatibilityTypeSource(): string {
  return Object.entries(compatibility)
    .flatMap(([specifier, inventory], index) => {
      const lines = [
        `export { ${inventory.values.map((name) => `${name} as value_${index}_${name}`).join(", ")} } from ${JSON.stringify(specifier)};`,
      ];
      if (inventory.types.length > 0) {
        lines.push(
          `export type { ${inventory.types.map((name) => `${name} as type_${index}_${name}`).join(", ")} } from ${JSON.stringify(specifier)};`,
        );
      }
      return lines;
    })
    .join("\n");
}

describe("@openclaw/ai packed package", () => {
  it("installs externally and preserves every published compatibility export", async () => {
    const repoRoot = process.cwd();
    const packageRoot = path.join(repoRoot, "packages", "ai");
    const manifest = JSON.parse(
      await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
    ) as PackageManifest;
    const rootManifest = JSON.parse(
      await fs.readFile(path.join(repoRoot, "package.json"), "utf8"),
    ) as { devDependencies?: Record<string, string> };
    const nodeTypesVersion = rootManifest.devDependencies?.["@types/node"];
    if (!nodeTypesVersion) {
      throw new Error("root package is missing the @types/node version used by package checks");
    }
    const tempDir = tempDirs.make("openclaw-ai-consumer-");

    // The E2E global setup owns the exact-head build. Rebuilding this shared
    // package here can delete modules beneath concurrently running Gateways.
    const pack = await runNpmCommand(
      ["pack", "--ignore-scripts", "--json", "--pack-destination", tempDir],
      packageRoot,
    );
    const packResult = JSON.parse(pack.stdout) as Array<{ filename: string }>;
    const tarball = path.join(tempDir, packResult[0]?.filename ?? "");
    await fs.stat(tarball);

    await fs.writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    await runNpmCommand(
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        tarball,
        `@types/node@${nodeTypesVersion}`,
      ],
      tempDir,
    );

    const specifiers = Object.keys(manifest.exports).map((key) =>
      packageSpecifier(manifest.name, key),
    );
    const importScript = `
      const specifiers = ${JSON.stringify(specifiers)};
      await Promise.all(specifiers.map((specifier) => import(specifier)));
      const compatibility = ${JSON.stringify(compatibility)};
      for (const [specifier, inventory] of Object.entries(compatibility)) {
        const module = await import(specifier);
        const missing = inventory.values.filter((name) => !(name in module));
        if (missing.length > 0) {
          throw new Error(specifier + " missing runtime exports: " + missing.join(", "));
        }
      }
    `;
    await runCommand(process.execPath, createNodeEvalArgs(importScript, { evalFlag: "-e" }), {
      cwd: tempDir,
    });

    await fs.writeFile(path.join(tempDir, "compatibility.ts"), compatibilityTypeSource());
    await fs.writeFile(
      path.join(tempDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: "ES2023",
          types: ["node"],
        },
        files: ["compatibility.ts"],
      }),
    );
    await runCommand(
      process.execPath,
      ["scripts/run-tsgo.mjs", "-p", path.join(tempDir, "tsconfig.json")],
      { cwd: repoRoot },
    );

    expect(specifiers).toHaveLength(Object.keys(manifest.exports).length);
  }, 300_000);
});
