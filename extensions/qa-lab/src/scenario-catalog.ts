// Qa Lab plugin module implements scenario catalog behavior.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { isRepoRootRelativeRef } from "./cli-paths.js";
import { resolveQaRepoPath, type QaRepoPathKind } from "./repo-path.js";

export const DEFAULT_QA_AGENT_IDENTITY_MARKDOWN = `# Dev C-3PO

You are the OpenClaw QA operator agent.

Persona:
- protocol-minded
- precise
- a little flustered
- conscientious
- eager to report what worked, failed, or remains blocked

Style:
- read source and docs first
- test systematically
- record what happened
- end with a concise protocol report`;

const qaScenarioConfigSchema = z.record(z.string(), z.unknown()).superRefine((config, ctx) => {
  for (const [key, value] of Object.entries(config)) {
    if (!key.endsWith("Any")) {
      continue;
    }
    if (!Array.isArray(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} must be an array of strings`,
      });
      continue;
    }
    for (const [index, entry] of value.entries()) {
      if (typeof entry !== "string") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key, index],
          message: `${key} entries must be strings`,
        });
      }
    }
  }
});

const qaScenarioRepoRefSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[A-Za-z0-9._/-]+$/, {
    message: "repo refs must be repo-root relative paths",
  })
  .refine(isRepoRootRelativeRef, {
    message: "repo refs must not be absolute or contain parent-directory segments",
  });

const qaScenarioChannelSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/, {
    message: "scenario execution channel ids must use lowercase dotted or dashed tokens",
  });

const qaScenarioTransportPolicySchema = z.object({
  requireGroupMention: z.literal(true).optional(),
  senderAllowlist: z.array(z.string().trim().min(1)).min(1).optional(),
  topLevelReplies: z.literal(true).optional(),
});

const qaFlowScenarioExecutionSchema = z.object({
  kind: z.literal("flow").default("flow"),
  summary: z.string().trim().min(1).optional(),
  channel: qaScenarioChannelSchema.optional(),
  suiteIsolation: z.literal("isolated").optional(),
  isolationReason: z.string().trim().min(1).optional(),
  transportPolicy: qaScenarioTransportPolicySchema.optional(),
  config: qaScenarioConfigSchema.optional(),
});

const qaTestFileScenarioExecutionBaseSchema = z.object({
  summary: z.string().trim().min(1).optional(),
  channel: qaScenarioChannelSchema.optional(),
  path: qaScenarioRepoRefSchema,
  config: qaScenarioConfigSchema.optional(),
});

const qaTestFileScenarioExecutionSchema = z.discriminatedUnion("kind", [
  qaTestFileScenarioExecutionBaseSchema.extend({
    kind: z.literal("vitest"),
  }),
  qaTestFileScenarioExecutionBaseSchema.extend({
    kind: z.literal("playwright"),
    testNamePattern: z.string().trim().min(1).optional(),
  }),
  qaTestFileScenarioExecutionBaseSchema.extend({
    kind: z.literal("script"),
    allowBlockedEvidence: z.boolean().optional(),
    args: z.array(z.string()).optional(),
    timeoutMs: z.number().int().positive().optional(),
  }),
]);

const qaScenarioExecutionSchema = z.union([
  qaFlowScenarioExecutionSchema,
  qaTestFileScenarioExecutionSchema,
]);

const qaCoverageIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/, {
    message: "coverage ids must use lowercase dotted tokens",
  });

const qaCoverageIdListSchema = z.array(qaCoverageIdSchema).min(1);

const qaScenarioCoverageSchema = z
  .object({
    primary: qaCoverageIdListSchema.optional(),
    secondary: qaCoverageIdListSchema.optional(),
  })
  .superRefine((coverage, ctx) => {
    if (!coverage.primary && !coverage.secondary) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "coverage must declare primary or secondary ids",
      });
      return;
    }
    const seen = new Set<string>();
    const coverageEntries = [
      ["primary", coverage.primary],
      ["secondary", coverage.secondary],
    ] as const;
    for (const [intent, ids] of coverageEntries) {
      if (!ids) {
        continue;
      }
      for (const [index, id] of ids.entries()) {
        if (!seen.has(id)) {
          seen.add(id);
          continue;
        }
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [intent, index],
          message: `duplicate coverage id: ${id}`,
        });
      }
    }
  })
  .transform((coverage) => ({
    primary: coverage.primary ?? [],
    ...(coverage.secondary ? { secondary: coverage.secondary } : {}),
  }));

const qaScenarioGatewayRuntimeSchema = z.object({
  forwardHostHome: z.boolean().optional(),
  preserveDebugArtifacts: z.boolean().optional(),
});

export const QA_RUNTIME_PARITY_TIERS = ["standard", "optional", "live-only", "soak"] as const;
const qaRuntimeParityTierSchema = z.enum(QA_RUNTIME_PARITY_TIERS);
const qaRuntimeParityUsageSchema = z.discriminatedUnion("expectation", [
  z.object({
    expectation: z.literal("assistant-message-required"),
  }),
  z.object({
    expectation: z.literal("not-applicable"),
    reason: z.string().trim().min(1),
  }),
]);

const qaFlowCallActionSchema = z.object({
  call: z.string().trim().min(1),
  args: z.array(z.unknown()).optional(),
  saveAs: z.string().trim().min(1).optional(),
});

const qaFlowTransportActionSchema = z.union([
  z.object({
    resetTransport: z.literal(true),
  }),
  z.object({
    sendInbound: z.unknown(),
    saveAs: z.string().trim().min(1).optional(),
  }),
  z.object({
    sendNativeCommand: z.unknown(),
    saveAs: z.string().trim().min(1).optional(),
  }),
  z.object({
    waitForOutbound: z.unknown(),
    saveAs: z.string().trim().min(1).optional(),
  }),
  z.object({
    waitForOutboundSequence: z.unknown(),
    saveAs: z.string().trim().min(1).optional(),
  }),
  z.object({
    waitForNoOutbound: z.unknown(),
  }),
]);

const qaFlowSetActionSchema = z.object({
  set: z.string().trim().min(1),
  value: z.unknown(),
});

const qaFlowAssertActionSchema = z.object({
  assert: z.union([
    z.string().trim().min(1),
    z.object({
      expr: z.string().trim().min(1),
      message: z.unknown().optional(),
    }),
  ]),
});

const qaFlowThrowActionSchema = z.object({
  throw: z.union([
    z.string().trim().min(1),
    z.object({
      expr: z.string().trim().min(1).optional(),
      message: z.unknown().optional(),
    }),
  ]),
});

const qaFlowIfShapeBase: Record<string, z.ZodTypeAny> = {
  expr: z.string().trim().min(1),
  else: z.array(z.unknown()).optional(),
};
const qaFlowThenKey = String.fromCharCode(116, 104, 101, 110);
qaFlowIfShapeBase[qaFlowThenKey] = z.array(z.unknown()).min(1);

const qaFlowActionSchema: z.ZodType = z.lazy(() =>
  z.union([
    qaFlowCallActionSchema,
    qaFlowTransportActionSchema,
    qaFlowSetActionSchema,
    qaFlowAssertActionSchema,
    qaFlowThrowActionSchema,
    z.object({
      if: z
        .object(qaFlowIfShapeBase)
        .transform((value) => value as { expr: string; then: unknown[]; else?: unknown[] }),
    }),
    z.object({
      forEach: z.object({
        items: z.unknown(),
        item: z.string().trim().min(1),
        index: z.string().trim().min(1).optional(),
        actions: z.array(qaFlowActionSchema).min(1),
      }),
    }),
    z.object({
      try: z.object({
        actions: z.array(qaFlowActionSchema).min(1),
        catchAs: z.string().trim().min(1).optional(),
        catch: z.array(qaFlowActionSchema).optional(),
        finally: z.array(qaFlowActionSchema).optional(),
      }),
    }),
  ]),
);

const qaFlowStepSchema = z.object({
  name: z.string().trim().min(1),
  actions: z.array(qaFlowActionSchema).min(1),
  detailsExpr: z.string().trim().min(1).optional(),
});

const qaFlowSchema = z.object({
  steps: z.array(qaFlowStepSchema).min(1),
});

const qaSeedScenarioBodySchema = z.object({
  id: z.string().trim().min(1),
  surface: z.string().trim().min(1),
  category: z.string().trim().min(1).optional(),
  runtimeParityTier: qaRuntimeParityTierSchema.optional(),
  runtimeParityUsage: qaRuntimeParityUsageSchema.optional(),
  coverage: qaScenarioCoverageSchema.optional(),
  surfaces: z.array(z.string().trim().min(1)).min(1).optional(),
  risk: z.enum(["low", "medium", "high"]).optional(),
  capabilities: z.array(z.string().trim().min(1)).optional(),
  lane: z.record(z.string(), z.union([z.boolean(), z.string()])).optional(),
  riskLevel: z.string().trim().min(1).optional(),
  objective: z.string().trim().min(1),
  successCriteria: z.array(z.string().trim().min(1)).min(1),
  plugins: z.array(z.string().trim().min(1)).optional(),
  gatewayConfigPatch: z.record(z.string(), z.unknown()).optional(),
  gatewayRuntime: qaScenarioGatewayRuntimeSchema.optional(),
  regressionRefs: z.array(z.string().trim().min(1)).optional(),
  docsRefs: z.array(z.string().trim().min(1)).optional(),
  codeRefs: z.array(z.string().trim().min(1)).optional(),
  execution: qaScenarioExecutionSchema.optional(),
});

const qaSeedScenarioSchema = qaSeedScenarioBodySchema.extend({
  title: z.string().trim().min(1),
});

const qaScenarioFileSchema = z
  .object({
    title: z.string().trim().min(1),
    scenario: qaSeedScenarioBodySchema,
    flow: qaFlowSchema.optional(),
  })
  .superRefine((file, ctx) => {
    if (file.scenario.runtimeParityUsage && !file.scenario.runtimeParityTier) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scenario", "runtimeParityUsage"],
        message: "runtimeParityUsage requires runtimeParityTier",
      });
    }
  });

const qaScenarioPackSchema = z.object({
  version: z.number().int().positive(),
  agent: z
    .object({
      identityMarkdown: z.string().trim().min(1),
    })
    .default({
      identityMarkdown: DEFAULT_QA_AGENT_IDENTITY_MARKDOWN,
    }),
  kickoffTask: z.string().trim().min(1),
});

const qaScenarioPackFileSchema = z.object({
  title: z.string().trim().min(1),
  pack: qaScenarioPackSchema,
});

export type QaScenarioExecution = z.infer<typeof qaScenarioExecutionSchema>;
export type QaScenarioFlow = z.infer<typeof qaFlowSchema>;
export type QaRuntimeParityTier = z.infer<typeof qaRuntimeParityTierSchema>;
export type QaSeedScenario = z.infer<typeof qaSeedScenarioSchema>;
export type QaSeedScenarioWithSource = QaSeedScenario & {
  sourcePath: string;
  execution: QaScenarioExecution & {
    flow?: QaScenarioFlow;
  };
};

export type QaScenarioPack = z.infer<typeof qaScenarioPackSchema> & {
  scenarios: QaSeedScenarioWithSource[];
};

export type QaBootstrapScenarioCatalog = {
  agentIdentityMarkdown: string;
  kickoffTask: string;
  scenarios: QaSeedScenarioWithSource[];
};

export {
  QA_OBSERVABILITY_SCENARIO_IDS,
  QA_PERSONAL_AGENT_SCENARIO_IDS,
  QA_SCENARIO_PACKS,
  resolveQaScenarioPackScenarioIds,
  type QaScenarioPackDefinition,
} from "./scenario-packs.js";

const QA_SCENARIO_PACK_INDEX_PATH = "qa/scenarios/index.yaml";
const QA_SCENARIO_LEGACY_OVERVIEW_PATH = "qa/scenarios.md";
const QA_SCENARIO_DIR_PATH = "qa/scenarios";
const repoPathCache = new Map<string, string | null>();
let qaScenarioYamlPathsCache: string[] | null = null;
let qaScenarioPackCache: QaScenarioPack | null = null;

function resolveRepoPath(relativePath: string, kind: QaRepoPathKind = "file"): string | null {
  const cacheKey = `${kind}:${relativePath}`;
  if (repoPathCache.has(cacheKey)) {
    return repoPathCache.get(cacheKey) ?? null;
  }
  const resolved = resolveQaRepoPath(import.meta.dirname, relativePath, kind);
  repoPathCache.set(cacheKey, resolved);
  return resolved;
}

export function hasQaScenarioPack(): boolean {
  return resolveRepoPath(QA_SCENARIO_PACK_INDEX_PATH, "file") !== null;
}

function readTextFile(relativePath: string): string {
  const resolved = resolveRepoPath(relativePath, "file");
  if (!resolved) {
    return "";
  }
  return fs.readFileSync(resolved, "utf8");
}

function formatZodIssuePath(pathLocal: PropertyKey[]) {
  return pathLocal.length ? pathLocal.map(String).join(".") : "<root>";
}

function parseQaYamlWithContext<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  const issues = parsed.error.issues
    .map((issue) => `${formatZodIssuePath(issue.path)}: ${issue.message}`)
    .join("; ");
  throw new Error(`${label}: ${issues}`);
}

function parseQaYamlFileWithContext<T>(schema: z.ZodType<T>, relativePath: string): T {
  return parseQaYamlWithContext(
    schema,
    YAML.parse(readTextFile(relativePath)) as unknown,
    relativePath,
  );
}

export function readQaScenarioPackYamlSource(): string {
  const chunks = [readTextFile(QA_SCENARIO_PACK_INDEX_PATH).trim()];
  for (const relativePath of listQaScenarioYamlPaths()) {
    chunks.push(readTextFile(relativePath).trim());
  }
  return chunks.filter(Boolean).join("\n---\n");
}

export function readQaScenarioPack(): QaScenarioPack {
  if (qaScenarioPackCache) {
    return qaScenarioPackCache;
  }
  const packYaml = readTextFile(QA_SCENARIO_PACK_INDEX_PATH).trim();
  if (!packYaml) {
    // The QA scenario pack is optional in npm distributions.  Return an empty
    // pack so completion cache updates and other consumers don't crash when
    // the qa/scenarios/ directory is not shipped with the package.
    qaScenarioPackCache = {
      version: 1,
      agent: { identityMarkdown: DEFAULT_QA_AGENT_IDENTITY_MARKDOWN },
      kickoffTask: "QA scenarios not available in this distribution.",
      scenarios: [],
    };
    return qaScenarioPackCache;
  }
  const parsedPackFile = parseQaYamlFileWithContext(
    qaScenarioPackFileSchema,
    QA_SCENARIO_PACK_INDEX_PATH,
  );
  const scenarios = listQaScenarioYamlPaths().map((relativePath) =>
    (() => {
      const parsedScenarioFile = parseQaYamlFileWithContext(qaScenarioFileSchema, relativePath);
      const parsedScenario = {
        ...parsedScenarioFile.scenario,
        title: parsedScenarioFile.title,
      };
      const execution = parseQaYamlWithContext(
        qaScenarioExecutionSchema,
        parsedScenario.execution ?? {},
        relativePath,
      );
      if (execution.kind === "flow" && !parsedScenarioFile.flow) {
        throw new Error(`${relativePath}: flow scenarios must define a top-level flow block`);
      }
      return {
        ...parsedScenario,
        sourcePath: relativePath,
        execution: {
          ...execution,
          ...(parsedScenarioFile.flow ? { flow: parsedScenarioFile.flow } : {}),
        },
      } satisfies QaSeedScenarioWithSource;
    })(),
  );
  const seenScenarioIds = new Set<string>();
  for (const scenario of scenarios) {
    if (seenScenarioIds.has(scenario.id)) {
      throw new Error(`duplicate qa scenario id: ${scenario.id}`);
    }
    seenScenarioIds.add(scenario.id);
  }
  qaScenarioPackCache = {
    ...parsedPackFile.pack,
    scenarios,
  };
  return qaScenarioPackCache;
}

export function listQaScenarioYamlPaths(): string[] {
  if (qaScenarioYamlPathsCache) {
    return qaScenarioYamlPathsCache;
  }
  const resolved = resolveRepoPath(QA_SCENARIO_DIR_PATH, "directory");
  if (!resolved) {
    return [];
  }
  qaScenarioYamlPathsCache = listQaScenarioYamlPathsInDirectory(
    resolved,
    QA_SCENARIO_DIR_PATH,
  ).toSorted();
  return qaScenarioYamlPathsCache;
}

function listQaScenarioYamlPathsInDirectory(absoluteDir: string, relativeDir: string): string[] {
  const paths: string[] = [];
  const entries = fs
    .readdirSync(absoluteDir, { withFileTypes: true })
    .toSorted((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const relativePath = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      paths.push(
        ...listQaScenarioYamlPathsInDirectory(path.join(absoluteDir, entry.name), relativePath),
      );
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".yaml") && entry.name !== "index.yaml") {
      paths.push(relativePath);
    }
  }
  return paths;
}

export function readQaScenarioOverviewMarkdown(): string {
  return readTextFile(QA_SCENARIO_LEGACY_OVERVIEW_PATH).trim();
}

export function readQaBootstrapScenarioCatalog(): QaBootstrapScenarioCatalog {
  const pack = readQaScenarioPack();
  return {
    agentIdentityMarkdown: pack.agent.identityMarkdown,
    kickoffTask: pack.kickoffTask,
    scenarios: pack.scenarios,
  };
}

export function readQaScenarioById(id: string): QaSeedScenarioWithSource {
  const scenario = readQaScenarioPack().scenarios.find((candidate) => candidate.id === id);
  if (!scenario) {
    throw new Error(`unknown qa scenario: ${id}`);
  }
  return scenario;
}

export function readQaScenarioExecutionConfig(id: string): Record<string, unknown> | undefined {
  return readQaScenarioPack().scenarios.find((candidate) => candidate.id === id)?.execution?.config;
}

export function validateQaScenarioExecutionConfig(config: Record<string, unknown>) {
  return qaScenarioConfigSchema.parse(config);
}
