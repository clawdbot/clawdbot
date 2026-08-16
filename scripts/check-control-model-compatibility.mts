import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { x as extractTar } from "tar";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { resolveNpmRunner } from "./npm-runner.mts";

type TargetName = "candidate" | "predecessor" | "main";

type ProtocolSchemaDocument = {
  methods: Record<string, { scope: string; since?: string }>;
  definitions: Record<string, TSchema>;
};

type CompatibilityOptions = {
  mainRef?: string;
  output?: string;
  predecessor: string;
};

type CompatibilityCase = {
  id: string;
  schema: string;
  value: unknown;
  expected: Record<TargetName, boolean>;
};

type CaseResult = {
  id: string;
  schema: string;
  expected: boolean;
  actual: boolean;
  errors: readonly { path: string; message: string }[];
};

type TargetResult = {
  source: string;
  commit?: string;
  methodCount: number;
  methods: Record<string, boolean>;
  cases: readonly CaseResult[];
  passed: boolean;
};

type CompatibilityResult = {
  config: {
    mainRef: string;
    predecessor: string;
  };
  targets: Record<TargetName, TargetResult>;
  passed: boolean;
};

type CommandResult = {
  stdout: string;
  stderr: string;
};

const DEFAULT_PREDECESSOR = "@openclaw/gateway-protocol@2026.7.2-beta.7";
const REQUIRED_METHODS = {
  "approval.resolve": "operator.approvals",
  "chat.abort": "operator.write",
  "chat.history": "operator.read",
  "chat.send": "operator.write",
  "chat.startup": "operator.read",
  "question.list": "operator.questions",
  "question.resolve": "operator.questions",
  "sessions.list": "operator.read",
  "sessions.messages.subscribe": "operator.read",
} as const;

const SESSION_KEY = "agent:main:compatibility";
const BASE_SEND = {
  sessionKey: SESSION_KEY,
  agentId: "main",
  message: "compatibility canary",
  deliver: false,
  idempotencyKey: "compatibility-send-1",
  expectedLeafEntryId: null,
  queueMode: "followup",
} as const;

const COMPATIBILITY_CASES: readonly CompatibilityCase[] = [
  {
    id: "session-list",
    schema: "SessionsListParams",
    value: { limit: 200, agentId: "main" },
    expected: { candidate: true, predecessor: true, main: true },
  },
  {
    id: "session-subscription-with-approvals",
    schema: "SessionsMessagesSubscribeParams",
    value: { key: SESSION_KEY, agentId: "main", includeApprovals: true },
    expected: { candidate: true, predecessor: true, main: true },
  },
  {
    id: "conversation-history",
    schema: "ChatHistoryParams",
    value: { sessionKey: SESSION_KEY, agentId: "main", limit: 200 },
    expected: { candidate: true, predecessor: true, main: true },
  },
  {
    id: "ordinary-send",
    schema: "ChatSendParams",
    value: BASE_SEND,
    expected: { candidate: true, predecessor: true, main: true },
  },
  {
    id: "run-fenced-send",
    schema: "ChatSendParams",
    value: { ...BASE_SEND, expectedRunId: "run-1" },
    expected: { candidate: true, predecessor: false, main: true },
  },
  {
    id: "exact-run-abort",
    schema: "ChatAbortParams",
    value: { sessionKey: SESSION_KEY, agentId: "main", runId: "run-1" },
    expected: { candidate: true, predecessor: true, main: true },
  },
  {
    id: "approval-resolution",
    schema: "ApprovalResolveParams",
    value: { id: "approval-1", kind: "exec", decision: "allow-once" },
    expected: { candidate: true, predecessor: true, main: true },
  },
  {
    id: "question-list",
    schema: "QuestionListParams",
    value: {},
    expected: { candidate: true, predecessor: true, main: true },
  },
  {
    id: "question-answer",
    schema: "QuestionResolveParams",
    value: { id: "question-1", answers: { answers: { choice: ["yes"] } } },
    expected: { candidate: true, predecessor: true, main: true },
  },
  {
    id: "question-cancel",
    schema: "QuestionResolveParams",
    value: { id: "question-1", cancel: true },
    expected: { candidate: true, predecessor: true, main: true },
  },
  {
    id: "stream-final-event",
    schema: "ChatEvent",
    value: {
      runId: "run-1",
      sessionKey: SESSION_KEY,
      seq: 1,
      state: "final",
      message: { role: "assistant", content: "done" },
    },
    expected: { candidate: true, predecessor: true, main: true },
  },
  {
    id: "tool-result-event",
    schema: "AgentEvent",
    value: {
      runId: "run-1",
      seq: 2,
      stream: "tool",
      ts: 1,
      data: { phase: "result", toolCallId: "tool-1", output: "done" },
    },
    expected: { candidate: true, predecessor: true, main: true },
  },
  {
    id: "question-resolved-event",
    schema: "QuestionResolvedEvent",
    value: {
      id: "question-1",
      status: "answered",
      answers: { answers: { choice: ["yes"] } },
    },
    expected: { candidate: true, predecessor: true, main: true },
  },
];

function parseOptions(argv: string[]): CompatibilityOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--") {
      continue;
    }
    if (!flag?.startsWith("--")) {
      throw new Error(`unexpected argument: ${flag ?? "end"}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    if (values.has(flag)) {
      throw new Error(`${flag} was provided more than once`);
    }
    values.set(flag, value);
    index += 1;
  }
  const knownFlags = new Set(["--main-ref", "--output", "--predecessor"]);
  for (const flag of values.keys()) {
    if (!knownFlags.has(flag)) {
      throw new Error(`unknown option: ${flag}`);
    }
  }
  return {
    mainRef: values.get("--main-ref"),
    output: values.get("--output"),
    predecessor: values.get("--predecessor") ?? DEFAULT_PREDECESSOR,
  };
}

function runCommand(
  command: string,
  args: readonly string[],
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
      env: options.env ?? process.env,
      shell: options.shell,
      stdio: ["ignore", "pipe", "pipe"],
      windowsVerbatimArguments: options.windowsVerbatimArguments,
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`command timed out: ${[command, ...args].join(" ")}`));
    }, options.timeoutMs ?? 180_000);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
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

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function readProtocolSchema(filePath: string): Promise<ProtocolSchemaDocument> {
  const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
  const document = record(parsed);
  const methods = record(document?.methods);
  const definitions = record(document?.definitions);
  if (!methods || !definitions) {
    throw new Error(`${filePath} is not an OpenClaw protocol schema document`);
  }
  return {
    methods: methods as ProtocolSchemaDocument["methods"],
    definitions: definitions as ProtocolSchemaDocument["definitions"],
  };
}

async function resolveMainRef(repoRoot: string, requested?: string): Promise<string> {
  const candidates = requested ? [requested] : ["upstream/main", "origin/main", "main"];
  for (const candidate of candidates) {
    try {
      await runCommand("git", ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], {
        cwd: repoRoot,
      });
      return candidate;
    } catch {
      // Try the next standard main ref.
    }
  }
  throw new Error(`could not resolve a main ref from: ${candidates.join(", ")}`);
}

async function generateCandidateSchema(repoRoot: string, destination: string): Promise<string> {
  await runCommand(
    process.execPath,
    ["--import", "tsx", "scripts/protocol-gen.ts", "--out", destination],
    { cwd: repoRoot },
  );
  return destination;
}

async function downloadPredecessorSchema(
  repoRoot: string,
  tempRoot: string,
  predecessor: string,
): Promise<string> {
  const packRoot = path.join(tempRoot, "predecessor");
  await fs.mkdir(packRoot, { recursive: true });
  const npmArgs = [
    "pack",
    predecessor,
    "--json",
    "--pack-destination",
    packRoot,
    "--ignore-scripts",
  ];
  const runner = resolveNpmRunner({ env: process.env, npmArgs });
  await runCommand(runner.command, runner.args, {
    cwd: repoRoot,
    env: runner.env ?? process.env,
    shell: runner.shell,
    windowsVerbatimArguments: runner.windowsVerbatimArguments,
  });
  const tarball = (await fs.readdir(packRoot)).find((entry) => entry.endsWith(".tgz"));
  if (!tarball) {
    throw new Error(`npm pack did not produce a tarball for ${predecessor}`);
  }
  const extractRoot = path.join(packRoot, "unpacked");
  await fs.mkdir(extractRoot, { recursive: true });
  extractTar({ file: path.join(packRoot, tarball), cwd: extractRoot, sync: true });
  return path.join(extractRoot, "package", "protocol.schema.json");
}

async function generateMainSchema(
  repoRoot: string,
  tempRoot: string,
  mainRef: string,
): Promise<{ commit: string; schemaPath: string }> {
  const worktree = path.join(tempRoot, "main");
  const commit = (
    await runCommand("git", ["rev-parse", `${mainRef}^{commit}`], { cwd: repoRoot })
  ).stdout.trim();
  await runCommand("git", ["worktree", "add", "--detach", "--quiet", worktree, mainRef], {
    cwd: repoRoot,
  });
  try {
    await fs.symlink(
      path.join(repoRoot, "node_modules"),
      path.join(worktree, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const schemaPath = path.join(worktree, "protocol.schema.json");
    await runCommand(
      process.execPath,
      ["--import", "tsx", path.join(worktree, "scripts", "protocol-gen.ts"), "--out", schemaPath],
      { cwd: repoRoot },
    );
    return { commit, schemaPath };
  } catch (error) {
    await runCommand("git", ["worktree", "remove", "--force", worktree], { cwd: repoRoot }).catch(
      () => undefined,
    );
    throw error;
  }
}

function validateTarget(
  name: TargetName,
  source: string,
  schema: ProtocolSchemaDocument,
  commit?: string,
): TargetResult {
  const methods = Object.fromEntries(
    Object.entries(REQUIRED_METHODS).map(([method, scope]) => [
      method,
      schema.methods[method]?.scope === scope,
    ]),
  );
  const cases = COMPATIBILITY_CASES.map((compatibilityCase): CaseResult => {
    const definition = schema.definitions[compatibilityCase.schema];
    const actual = definition ? Value.Check(definition, compatibilityCase.value) : false;
    const errors = definition
      ? [...Value.Errors(definition, compatibilityCase.value)].map((error) => ({
          path: error.path ?? "",
          message: error.message,
        }))
      : [{ path: "", message: `missing schema ${compatibilityCase.schema}` }];
    return {
      id: compatibilityCase.id,
      schema: compatibilityCase.schema,
      expected: compatibilityCase.expected[name],
      actual,
      errors: actual ? [] : errors,
    };
  });
  return {
    source,
    ...(commit ? { commit } : {}),
    methodCount: Object.keys(schema.methods).length,
    methods,
    cases,
    passed:
      Object.values(methods).every(Boolean) &&
      cases.every((result) => result.actual === result.expected),
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const repoRoot = process.cwd();
  const mainRef = await resolveMainRef(repoRoot, options.mainRef);
  const tempBase = path.join(repoRoot, ".tmp");
  await fs.mkdir(tempBase, { recursive: true });
  const tempRoot = await fs.mkdtemp(path.join(tempBase, "control-model-compatibility-"));
  const mainWorktree = path.join(tempRoot, "main");
  try {
    const candidateSchemaPath = await generateCandidateSchema(
      repoRoot,
      path.join(tempRoot, "candidate.schema.json"),
    );
    const predecessorSchemaPath = await downloadPredecessorSchema(
      repoRoot,
      tempRoot,
      options.predecessor,
    );
    const mainSchema = await generateMainSchema(repoRoot, tempRoot, mainRef);
    const candidateCommit = (
      await runCommand("git", ["rev-parse", "HEAD"], { cwd: repoRoot })
    ).stdout.trim();
    const result: CompatibilityResult = {
      config: {
        mainRef,
        predecessor: options.predecessor,
      },
      targets: {
        candidate: validateTarget(
          "candidate",
          `working-tree@${candidateCommit}`,
          await readProtocolSchema(candidateSchemaPath),
          candidateCommit,
        ),
        predecessor: validateTarget(
          "predecessor",
          options.predecessor,
          await readProtocolSchema(predecessorSchemaPath),
        ),
        main: validateTarget(
          "main",
          `${mainRef}@${mainSchema.commit}`,
          await readProtocolSchema(mainSchema.schemaPath),
          mainSchema.commit,
        ),
      },
      passed: false,
    };
    result.passed = Object.values(result.targets).every((target) => target.passed);
    const output = `${JSON.stringify(result, null, 2)}\n`;
    process.stdout.write(output);
    if (options.output) {
      await fs.writeFile(path.resolve(repoRoot, options.output), output);
    }
    if (!result.passed) {
      process.exitCode = 1;
    }
  } finally {
    await runCommand("git", ["worktree", "remove", "--force", mainWorktree], {
      cwd: repoRoot,
    }).catch(() => undefined);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
