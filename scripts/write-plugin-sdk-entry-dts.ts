// CI artifacts use the same SDK declaration partitions as full/package builds.
import fs from "node:fs";
import path from "node:path";
import configs from "../tsdown.config.ts";
import { resolveBuildStepCacheState, type BuildCacheStep } from "./lib/build-artifact-cache.mts";
import { publishStagedDeclarations } from "./lib/declaration-stage.mts";
import { withDistArtifactOwnership } from "./lib/dist-artifact-ownership.mts";
import { TSDOWN_PLUGIN_SDK_DTS_CONFIG_GROUPS } from "./lib/tsdown-config-groups.mts";
import {
  prepareTsdownBuildExecution,
  TSDOWN_DECLARATION_EXTENSIONS,
  TSDOWN_UNIFIED_CACHE_INPUTS,
} from "./tsdown-build.mts";

const root = process.cwd();
let staging: string | undefined;
const failures: unknown[] = [];
try {
  await withDistArtifactOwnership(root, async () => {
    staging = fs.mkdtempSync(path.join(root, ".artifacts/plugin-sdk-staging-"));
    const output = path.join(staging, "dist");
    const required: string[] = [];
    for (const name of TSDOWN_PLUGIN_SDK_DTS_CONFIG_GROUPS) {
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
      for (const source of config.dts.entry) {
        const selected = Object.entries(config.entry).find(([, input]) => input === source);
        if (!selected) {
          throw new Error(`Missing canonical SDK entry for ${source}`);
        }
        required.push(`${selected[0]}.d.ts`);
      }
    }
    if (!required.length) {
      throw new Error("Canonical SDK declaration selection is empty");
    }
    const args = [
      "--config",
      "tsdown.config.ts",
      ...TSDOWN_PLUGIN_SDK_DTS_CONFIG_GROUPS.flatMap((group) => ["--filter", group]),
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
      throw new Error("Insufficient memory for SDK declaration build");
    }
    const step: BuildCacheStep = {
      label: "tsdown-plugin-sdk",
      cache: {
        env: ["OPENCLAW_BUILD_PRIVATE_QA"],
        inputs: [
          ...TSDOWN_UNIFIED_CACHE_INPUTS,
          "scripts/write-plugin-sdk-entry-dts.ts",
          "scripts/lib/declaration-stage.mts",
        ],
        outputs: [{ path: "dist", extensions: TSDOWN_DECLARATION_EXTENSIONS }],
        requiredOutputs: required.map((entry) => `dist/${entry}`),
        restore: "always",
      },
    };
    const params = {
      rootDir: root,
      artifactRoot: staging,
      env: {
        ...process.env,
        OPENCLAW_BUILD_PRIVATE_QA: process.env.OPENCLAW_BUILD_PRIVATE_QA === "1" ? "1" : "0",
      },
    };
    await publishStagedDeclarations(
      plan,
      output,
      path.join(root, "dist"),
      required,
      process.env.OPENCLAW_BUILD_CACHE === "0"
        ? undefined
        : { step, state: resolveBuildStepCacheState(step, params), params },
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
    : new AggregateError(failures, "SDK build and staging cleanup failed");
}
