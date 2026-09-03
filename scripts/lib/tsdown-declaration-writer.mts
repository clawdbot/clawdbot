// Canonical declaration groups share one private compiler and publication lifetime.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  prepareTsdownBuildExecution,
  TSDOWN_DECLARATION_EXTENSIONS,
  TSDOWN_UNIFIED_CACHE_ENV,
} from "../tsdown-build.mts";
import {
  finalizeBuildStepCache,
  portableRelativePath,
  restoreBuildStepCacheOutputs,
  resolveBuildStepCacheState,
  resolveTsdownCompilerFiles,
  type BuildCacheStep,
} from "./build-artifact-cache.mts";
import { CompilerInputSnapshot } from "./compiler-input-snapshot.mts";
import { publishStagedDeclarations } from "./declaration-stage.mts";
import { withDistArtifactOwnership } from "./dist-artifact-ownership.mts";
import { resolveTsdownDeclarationGeneratorInputs } from "./tsdown-declaration-generator-inputs.mts";
import {
  createDeclarationStage,
  readDeclarationInputs,
  requestDeclarationInputs,
} from "./tsdown-declaration-inputs.mts";

export async function writeTsdownDeclarations(
  groups: readonly string[],
  label: string,
  previousOutputs: (root: string) => string[],
  generatorEntry: string,
) {
  const root = process.cwd();
  const stages: string[] = [];
  const createStage = () => {
    const stage = createDeclarationStage(root);
    stages.push(stage);
    return stage;
  };
  const failures: unknown[] = [];
  try {
    await withDistArtifactOwnership(root, async () => {
      const { default: configs }: { default: typeof import("../../tsdown.config.ts").default } =
        await import(pathToFileURL(path.join(root, "tsdown.config.ts")).href);
      const staging = createStage();
      const output = path.join(staging, "dist");
      const environment = TSDOWN_UNIFIED_CACHE_ENV.map((name) =>
        JSON.stringify([name, process.env[name] ?? ""]),
      );
      const generatorInputs = resolveTsdownDeclarationGeneratorInputs(root, generatorEntry);
      const snapshot = () =>
        new CompilerInputSnapshot(root, {
          toolchainFiles: resolveTsdownCompilerFiles(),
          generatorInputs,
          isGeneratorInput: (file) => /(?:^|\/)(?:package|openclaw\.plugin)\.json$/u.test(file),
        });
      // All groups share the same before/after reads of configuration, topology,
      // tools and overlapping sources. Only compiler membership differs.
      const before = snapshot();
      const liveDist = path.join(root, "dist");
      const prepared = groups.map((name) => {
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
        const required = config.dts.entry.map((source) => {
          const resolved = path.resolve(root, source);
          const selected = entries.find(([, inputs]) => inputs.includes(resolved));
          if (!selected) {
            throw new Error(`Missing canonical declaration entry for ${source}`);
          }
          return `${selected[0]}.d.ts`;
        });
        const identity = [
          ...environment,
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
        ];
        const stage = createStage();
        const groupOutput = path.join(stage, "dist");
        requestDeclarationInputs(groupOutput, name, config.dts.entry);
        const plan = prepareTsdownBuildExecution(
          {
            args: ["--config", "tsdown.config.ts", "--filter", name, "--out-dir", groupOutput],
          },
          {
            // Every compiler owns a fresh stage; live runtime outputs stay intact.
            cleanup() {},
            reportShortfall(shortfall) {
              console.error(shortfall.message);
            },
          },
        );
        if (!plan) {
          throw new Error("Insufficient memory for declaration build");
        }
        const receipt = `compiler-inputs/${name}.json`;
        const step: BuildCacheStep = {
          label: `${label}-${name}`,
          cache: {
            env: TSDOWN_UNIFIED_CACHE_ENV,
            inputs: generatorInputs,
            // An empty canonical partition still owns its successful compiler
            // receipt. Ordinary cache records never admit an empty inventory.
            outputs: [{ path: "dist", extensions: TSDOWN_DECLARATION_EXTENSIONS }, receipt],
            requiredOutputs: [...required.map((entry) => `dist/${entry}`), receipt],
            restore: "always",
          },
        };
        const params = {
          rootDir: root,
          artifactRoot: stage,
          env: {
            ...process.env,
            OPENCLAW_BUILD_PRIVATE_QA: process.env.OPENCLAW_BUILD_PRIVATE_QA === "1" ? "1" : "0",
          },
          inputSignature: (inputs: string[]) =>
            before.signature("tsconfig.json", identity, inputs, liveDist),
        };
        const state =
          process.env.OPENCLAW_BUILD_CACHE === "0"
            ? undefined
            : resolveBuildStepCacheState(step, params);
        if (!state) {
          params.inputSignature([]);
        }
        // Record the lookup before compilation replaces the signature and cache record.
        console.error(
          `[${label}] ${name}: cache ${state?.fresh ? "hit" : "miss"} (${state?.reason ?? "disabled"})`,
        );
        return { name, output: groupOutput, required, identity, plan, step, params, state };
      });
      const required = prepared.flatMap((group) => group.required);
      if (!required.length) {
        throw new Error("Canonical declaration selection is empty");
      }
      const startedAt = Date.now();
      for (const group of prepared) {
        if (group.state?.fresh && !restoreBuildStepCacheOutputs(group.state, group.params)) {
          throw new Error("Declaration cache changed before restoration; rerun the build");
        }
      }
      // Keep the existing bounded, sequential executor. Hits never enter a
      // compiler; misses cannot publish or refresh caches before every group joins.
      const plan = {
        ...prepared[0]!.plan,
        invocations: prepared.flatMap((group) =>
          group.state?.fresh ? [] : group.plan.invocations,
        ),
      };
      await publishStagedDeclarations(
        plan,
        prepared.map((group) => ({ output: group.output, required: group.required })),
        output,
        liveDist,
        required,
        previousOutputs(root).map((file) => portableRelativePath(liveDist, file)),
        () => {
          const after = snapshot();
          for (const group of prepared) {
            const sealed = after.seal(
              "tsconfig.json",
              group.identity,
              readDeclarationInputs(group.output, [group.name]),
              before,
              startedAt,
              liveDist,
            );
            if (group.state?.fresh && sealed.signature !== group.state.signature) {
              throw new Error(`Cached declaration membership changed: ${group.name}`);
            }
            if (group.state) {
              group.state.signature = sealed.signature;
              group.state.consumedInputs = sealed.inputs;
            }
          }
        },
      );
      for (const group of prepared) {
        if (group.state && !group.state.fresh) {
          finalizeBuildStepCache(group.step, group.state, group.params);
        }
      }
      if (prepared.every((group) => group.state?.fresh)) {
        console.log(`[${label}] restored complete cached generation`);
      }
    });
  } catch (error) {
    failures.push(error);
  }
  for (const stage of stages) {
    try {
      fs.rmSync(stage, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  // The private entry observes this after module evaluation. Keep unjoined build
  // metadata even if removing the private staging tree also failed.
  if (failures.length) {
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(failures, "Declaration build and staging cleanup failed");
  }
}
