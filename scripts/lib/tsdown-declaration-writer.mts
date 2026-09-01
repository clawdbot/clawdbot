// Canonical declaration groups share one private compiler and publication lifetime.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  prepareTsdownBuildExecution,
  TSDOWN_DECLARATION_EXTENSIONS,
  TSDOWN_DECLARATION_TOOL_INPUTS,
  TSDOWN_UNIFIED_CACHE_ENV,
} from "../tsdown-build.mts";
import {
  portableRelativePath,
  resolveBuildStepCacheState,
  resolveTsdownCompilerFiles,
  type BuildCacheStep,
} from "./build-artifact-cache.mts";
import { CompilerInputSnapshot } from "./compiler-input-snapshot.mts";
import { publishStagedDeclarations } from "./declaration-stage.mts";
import { withDistArtifactOwnership } from "./dist-artifact-ownership.mts";
import {
  createDeclarationStage,
  readDeclarationInputs,
  requestDeclarationInputs,
} from "./tsdown-declaration-inputs.mts";

export async function writeTsdownDeclarations(
  groups: readonly string[],
  label: string,
  previousOutputs: (root: string) => string[],
) {
  const root = process.cwd();
  let staging: string | undefined;
  const failures: unknown[] = [];
  try {
    await withDistArtifactOwnership(root, async () => {
      const { default: configs }: { default: typeof import("../../tsdown.config.ts").default } =
        await import(pathToFileURL(path.join(root, "tsdown.config.ts")).href);
      staging = createDeclarationStage(root);
      const output = path.join(staging, "dist");
      const required: string[] = [];
      const identity = TSDOWN_UNIFIED_CACHE_ENV.map((name) =>
        JSON.stringify([name, process.env[name] ?? ""]),
      );
      for (const name of groups) {
        const config = configs.find((candidate: { name?: string }) => candidate.name === name);
        if (
          !config?.dts ||
          typeof config.dts !== "object" ||
          !Array.isArray(config.dts.entry) ||
          !config.entry ||
          typeof config.entry !== "object" ||
          Array.isArray(config.entry)
        ) {
          throw new Error(`Missing canonical declaration group ${name}`);
        }
        // Runtime worker entries are absolute; declaration partitions are checkout-relative.
        const entries = Object.entries(config.entry).map(
          ([entry, inputs]) =>
            [entry, [inputs].flat().map((input) => path.resolve(root, input))] as const,
        );
        for (const source of config.dts.entry) {
          const resolved = path.resolve(root, source);
          const selected = entries.find(([, inputs]) => inputs.includes(resolved));
          if (!selected) {
            throw new Error(`Missing canonical declaration entry for ${source}`);
          }
          required.push(`${selected[0]}.d.ts`);
        }
        identity.push(
          JSON.stringify({
            name,
            entry: Object.fromEntries(
              entries.map(([entry, sources]) => [
                entry,
                sources.map((source) => portableRelativePath(root, source)),
              ]),
            ),
            declarations: config.dts.entry,
            sourcemap: config.sourcemap,
          }),
        );
        if (process.env.OPENCLAW_BUILD_CACHE !== "0") {
          requestDeclarationInputs(output, name, config.dts.entry);
        }
      }
      if (!required.length) {
        throw new Error("Canonical declaration selection is empty");
      }
      const args = [
        "--config",
        "tsdown.config.ts",
        ...groups.flatMap((group) => ["--filter", group]),
        "--out-dir",
        output,
      ];
      const plan = prepareTsdownBuildExecution(
        { args },
        {
          // The staging directory is fresh. In particular, do not prune live runtime
          // symlinks or source outputs, and never clean between declaration groups.
          cleanup() {},
          reportShortfall(shortfall) {
            console.error(shortfall.message);
          },
        },
      );
      if (!plan) {
        throw new Error("Insufficient memory for declaration build");
      }
      const generatorInputs = [
        ...TSDOWN_DECLARATION_TOOL_INPUTS,
        "tsdown.config.ts",
        "scripts/write-plugin-sdk-entry-dts.ts",
        "scripts/write-unified-entry-dts.ts",
        "scripts/lib/tsdown-declaration-writer.mts",
        "scripts/lib/declaration-stage.mts",
        "scripts/lib/compiler-input-snapshot.mts",
        "scripts/lib/tsdown-declaration-inputs.mts",
        "src/infra/runtime-process-entrypoints.ts",
        "extensions/memory-core/src/memory/manager-search-knn-entrypoint.ts",
      ];
      const step: BuildCacheStep = {
        label,
        cache: {
          env: TSDOWN_UNIFIED_CACHE_ENV,
          inputs: generatorInputs,
          outputs: [{ path: "dist", extensions: TSDOWN_DECLARATION_EXTENSIONS }],
          requiredOutputs: required.map((entry) => `dist/${entry}`),
          restore: "always",
        },
      };
      const snapshot = () =>
        new CompilerInputSnapshot(root, {
          toolchainFiles: resolveTsdownCompilerFiles(),
          generatorInputs,
          // Config evaluation reads generator modules and package/plugin metadata.
          // Keep those bytes conservative; only ordinary compiler sources narrow.
          isGeneratorInput: (file) =>
            file.startsWith("scripts/") ||
            /(?:^|\/)(?:package|openclaw\.plugin)\.json$/u.test(file),
        });
      const before = snapshot();
      const liveDist = path.join(root, "dist");
      const inputSignature = (inputs: string[]) =>
        before.signature("tsconfig.json", identity, inputs, liveDist);
      const params = {
        rootDir: root,
        artifactRoot: staging,
        env: {
          ...process.env,
          OPENCLAW_BUILD_PRIVATE_QA: process.env.OPENCLAW_BUILD_PRIVATE_QA === "1" ? "1" : "0",
        },
        inputSignature,
      };
      const state =
        process.env.OPENCLAW_BUILD_CACHE === "0"
          ? undefined
          : resolveBuildStepCacheState(step, params);
      const startedAt = Date.now();
      await publishStagedDeclarations(
        plan,
        output,
        liveDist,
        required,
        previousOutputs(root).map((file) => portableRelativePath(liveDist, file)),
        state
          ? {
              step,
              state,
              params,
              sealInputs: () =>
                snapshot().seal(
                  "tsconfig.json",
                  identity,
                  readDeclarationInputs(output, groups),
                  before,
                  startedAt,
                  liveDist,
                ),
            }
          : undefined,
      );
    });
  } catch (error) {
    failures.push(error);
  }
  try {
    if (staging) {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  } catch (error) {
    failures.push(error);
  }
  // The private entry observes this after module evaluation. Keep unjoined build
  // metadata even if removing the private staging tree also failed.
  if (failures.length) {
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(failures, "Declaration build and staging cleanup failed");
  }
}
