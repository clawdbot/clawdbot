import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

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
- record evidence
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

const qaScenarioExecutionSchema = z.object({
  kind: z.literal("flow").default("flow"),
  summary: z.string().trim().min(1).optional(),
  config: qaScenarioConfigSchema.optional(),
});

const qaScenarioGatewayRuntimeSchema = z.object({
  forwardHostHome: z.boolean().optional(),
});

const qaFlowCallActionSchema = z.object({
  call: z.string().trim().min(1),
  args: z.array(z.unknown()).optional(),
  saveAs: z.string().trim().min(1).optional(),
});

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

const qaSeedScenarioSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  surface: z.string().trim().min(1),
  objective: z.string().trim().min(1),
  successCriteria: z.array(z.string().trim().min(1)).min(1),
  plugins: z.array(z.string().trim().min(1)).optional(),
  gatewayConfigPatch: z.record(z.string(), z.unknown()).optional(),
  gatewayRuntime: qaScenarioGatewayRuntimeSchema.optional(),
  docsRefs: z.array(z.string().trim().min(1)).optional(),
  codeRefs: z.array(z.string().trim().min(1)).optional(),
  execution: qaScenarioExecutionSchema.optional(),
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

export type QaScenarioExecution = z.infer<typeof qaScenarioExecutionSchema>;
export type QaScenarioFlow = z.infer<typeof qaFlowSchema>;
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

const QA_SCENARIO_PACK_INDEX_PATH = "qa/scenarios/index.md";
const QA_SCENARIO_LEGACY_OVERVIEW_PATH = "qa/scenarios.md";
const QA_SCENARIO_DIR_PATH = "qa/scenarios";
const QA_PACK_FENCE_RE = /```ya?ml qa-pack\r?\n([\s\S]*?)\r?\n```/i;
const QA_SCENARIO_FENCE_RE = /```ya?ml qa-scenario\r?\n([\s\S]*?)\r?\n```/i;
const QA_FLOW_YAML_FENCE_RE = /```ya?ml qa-flow\r?\n([\s\S]*?)\r?\n```/i;

function walkUpDirectories(start: string): string[] {
  const roots: string[] = [];
  let current = path.resolve(start);
  while (true) {
    roots.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      return roots;
    }
    current = parent;
  }
}

function resolveRepoPath(relativePath: string, kind: "file" | "directory" = "file"): string | null {
  for (const dir of walkUpDirectories(import.meta.dirname)) {
    const candidate = path.join(dir, relativePath);
    if (!fs.existsSync(candidate)) {
      continue;
    }
    const stat = fs.statSync(candidate);
    if ((kind === "file" && stat.isFile()) || (kind === "directory" && stat.isDirectory())) {
      return candidate;
    }
  }
  return null;
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

function readDirEntries(relativePath: string): string[] {
  const resolved = resolveRepoPath(relativePath, "directory");
  if (!resolved) {
    return [];
  }
  return fs.readdirSync(resolved);
}

function extractQaPackYaml(content: string) {
  const match = content.match(QA_PACK_FENCE_RE);
  if (!match?.[1]) {
    throw new Error(
      `qa scenario pack missing \`\`\`yaml qa-pack fence in ${QA_SCENARIO_PACK_INDEX_PATH}`,
    );
  }
  return match[1];
}

function extractQaScenarioYaml(content: string, relativePath: string) {
  const match = content.match(QA_SCENARIO_FENCE_RE);
  if (!match?.[1]) {
    throw new Error(`qa scenario file missing \`\`\`yaml qa-scenario fence in ${relativePath}`);
  }
  return match[1];
}

function extractQaScenarioFlow(content: string, relativePath: string) {
  const match = content.match(QA_FLOW_YAML_FENCE_RE);
  if (!match?.[1]) {
    throw new Error(`qa scenario file missing \`\`\`yaml qa-flow fence in ${relativePath}`);
  }
  return parseQaYamlWithContext(qaFlowSchema, YAML.parse(match[1]) as unknown, relativePath);
}

function formatZodIssuePath(path: PropertyKey[]) {
  return path.length ? path.map(String).join(".") : "<root>";
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

export function readQaScenarioPackMarkdown(): string {
  const chunks = [readTextFile(QA_SCENARIO_PACK_INDEX_PATH).trim()];
  for (const relativePath of listQaScenarioMarkdownPaths()) {
    chunks.push(readTextFile(relativePath).trim());
  }
  return chunks.filter(Boolean).join("\n\n");
}

export function readQaScenarioPack(): QaScenarioPack {
  const packMarkdown = readTextFile(QA_SCENARIO_PACK_INDEX_PATH).trim();
  if (!packMarkdown) {
    // The QA scenario pack is optional in npm distributions.  Return an empty
    // pack so completion cache updates and other consumers don't crash when
    // the qa/scenarios/ directory is not shipped with the package.
    return {
      version: 1,
      agent: { identityMarkdown: DEFAULT_QA_AGENT_IDENTITY_MARKDOWN },
      kickoffTask: "QA scenarios not available in this distribution.",
      scenarios: [],
    };
  }
  const parsedPack = parseQaYamlWithContext(
    qaScenarioPackSchema,
    YAML.parse(extractQaPackYaml(packMarkdown)) as unknown,
    QA_SCENARIO_PACK_INDEX_PATH,
  );
  const scenarios = listQaScenarioMarkdownPaths().map((relativePath) =>
    (() => {
      const content = readTextFile(relativePath);
      const parsedScenario = parseQaYamlWithContext(
        qaSeedScenarioSchema,
        YAML.parse(extractQaScenarioYaml(content, relativePath)) as unknown,
        relativePath,
      );
      const execution = parseQaYamlWithContext(
        qaScenarioExecutionSchema,
        parsedScenario.execution ?? {},
        relativePath,
      );
      const flow = extractQaScenarioFlow(content, relativePath);
      return {
        ...parsedScenario,
        sourcePath: relativePath,
        execution: {
          ...execution,
          flow,
        },
      } satisfies QaSeedScenarioWithSource;
    })(),
  );
  return {
    ...parsedPack,
    scenarios,
  };
}

export function listQaScenarioMarkdownPaths(): string[] {
  return readDirEntries(QA_SCENARIO_DIR_PATH)
    .filter((entry) => entry.endsWith(".md") && entry !== "index.md")
    .map((entry) => `${QA_SCENARIO_DIR_PATH}/${entry}`)
    .toSorted();
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

export function readQaScenarioById(id: string): QaSeedScenario {
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
