import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { explainShellCommand } from "./command-explainer/extract.js";
import type {
  CommandExplanation,
  CommandOperator,
  CommandRisk,
  CommandStep,
} from "./command-explainer/types.js";
import { isDispatchWrapperExecutable } from "./dispatch-wrapper-resolution.js";
import {
  type ExecCommandAnalysis,
  type ExecCommandSegment,
  resolveCommandResolutionFromArgv,
  type ShellChainOperator,
} from "./exec-approvals-analysis.js";
import {
  extractBindableShellWrapperInlineCommand,
  normalizeExecutableToken,
} from "./exec-wrapper-resolution.js";
import {
  hasPosixInteractiveStartupBeforeInlineCommand,
  hasPosixLoginStartupBeforeInlineCommand,
  isDirectShellPositionalCarrierCommand,
  POSIX_INLINE_COMMAND_FLAGS,
  resolveInlineCommandMatch,
} from "./shell-inline-command.js";
import { POSIX_PARSEABLE_SHELL_WRAPPERS } from "./shell-wrapper-resolution.js";

const POSIX_SHELL_NAMES: ReadonlySet<string> = new Set(POSIX_PARSEABLE_SHELL_WRAPPERS);

type ExecAuthorizationDialect = "argv" | "posix-shell" | "windows-cmd" | "powershell";

type ExecAuthorizationRelationship = "simple" | "pipeline";

type ExecAuthorizationTransport =
  | { kind: "direct" }
  | {
      kind: "shell-wrapper";
      wrapperSegment: ExecCommandSegment;
      wrapperArgv: string[];
      wrapperPrefix: string;
      inlineCommand: string;
    };

type ExecAuthorizationTrustMode = "executable" | "exact-command" | "prompt-only";

export type ExecAuthorizationCandidate = {
  sourceSegment: ExecCommandSegment;
  sourceStep: CommandStep;
  sourceStepId?: string;
  transport: ExecAuthorizationTransport;
  trustMode: ExecAuthorizationTrustMode;
  allowAlways: boolean;
  reasons: string[];
};

type ExecAuthorizationGroup = {
  opToNext?: ShellChainOperator | null;
  candidates: ExecAuthorizationCandidate[];
};

export type ExecAuthorizationPlan =
  | {
      ok: true;
      dialect: ExecAuthorizationDialect;
      originalCommand: string;
      groups: ExecAuthorizationGroup[];
      operators: CommandOperator[];
    }
  | {
      ok: false;
      dialect: ExecAuthorizationDialect;
      originalCommand: string;
      reason: string;
      groups: [];
      operators: [];
    };

type CommandStepWithSegment = {
  step: CommandStep;
  segment: ExecCommandSegment;
};

type PlanningContext = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

const PROMPT_ONLY_RISKS = new Set<CommandRisk["kind"]>([
  "eval",
  "source",
  "alias",
  "shell-wrapper-through-carrier",
  "command-carrier",
]);
const NON_REUSABLE_RISKS = new Set<CommandRisk["kind"]>(["inline-eval"]);

const UNANALYZABLE_RISKS = new Set<CommandRisk["kind"]>([
  "command-substitution",
  "dynamic-executable",
  "line-continuation",
  "heredoc",
  "here-string",
  "process-substitution",
  "redirect",
  "syntax-error",
  "function-definition",
]);

const POWERSHELL_NAMES = new Set(["powershell", "pwsh"]);
const WINDOWS_CMD_NAMES = new Set(["cmd", "cmd.exe"]);
const POSITIONAL_CARRIER_BLOCKED_EXECUTABLES = new Set(["find", "xargs"]);
const SHELL_WRAPPER_PRELUDE_REASON = "shell-env-assignment";
const UNSUPPORTED_DIRECT_SHELL_TOPOLOGY_SHAPES = new Set<CommandExplanation["shapes"][number]>([
  "background",
  "if",
  "for",
  "while",
  "case",
  "subshell",
  "group",
]);

function normalizePlanningPlatform(platform?: string | null): NodeJS.Platform | undefined {
  switch (platform) {
    case "aix":
    case "android":
    case "cygwin":
    case "darwin":
    case "freebsd":
    case "haiku":
    case "linux":
    case "netbsd":
    case "openbsd":
    case "sunos":
    case "win32":
      return platform;
    default:
      return undefined;
  }
}

function commandSegmentFromStep(step: CommandStep, context: PlanningContext): ExecCommandSegment {
  return {
    raw: step.text,
    argv: step.argv,
    resolution: resolveCommandResolutionFromArgv(
      step.argv,
      context.cwd,
      context.env,
      context.platform,
    ),
  };
}

function commandSegmentFromArgv(
  argv: string[],
  context: PlanningContext,
  sourceArgv?: string[],
): ExecCommandSegment {
  return {
    raw: argv.join(" "),
    argv,
    sourceArgv,
    resolution: resolveCommandResolutionFromArgv(argv, context.cwd, context.env, context.platform),
  };
}

type AuthorizationOperator = ShellChainOperator | "pipe";

function authorizationOperatorForTopology(operator: CommandOperator): AuthorizationOperator {
  switch (operator.kind) {
    case "and":
      return "&&";
    case "or":
      return "||";
    case "pipe":
    case "stderr-pipe":
      return "pipe";
    case "sequence":
    case "newline-sequence":
      return ";";
    case "background":
      return "&";
    default: {
      const unreachable: never = operator.kind;
      return unreachable;
    }
  }
}

function riskInsideStep(risk: CommandRisk, step: CommandStep): boolean {
  return risk.span.startIndex >= step.span.startIndex && risk.span.endIndex <= step.span.endIndex;
}

function riskBeforeStepExecutable(risk: CommandRisk, step: CommandStep): boolean {
  return riskInsideStep(risk, step) && risk.span.endIndex <= step.executableSpan.startIndex;
}

function stepReasons(step: CommandStep, risks: readonly CommandRisk[]): string[] {
  const reasons: string[] = [];
  for (const risk of risks) {
    if (PROMPT_ONLY_RISKS.has(risk.kind) && riskInsideStep(risk, step)) {
      reasons.push(risk.kind);
    }
  }
  return uniqueStrings(reasons);
}

function nonReusableStepReasons(step: CommandStep, risks: readonly CommandRisk[]): string[] {
  const reasons: string[] = [];
  for (const risk of risks) {
    if (NON_REUSABLE_RISKS.has(risk.kind) && riskInsideStep(risk, step)) {
      reasons.push(risk.kind);
    }
  }
  return uniqueStrings(reasons);
}

function isShellExpansionDynamicArgument(risk: CommandRisk): boolean {
  return (
    risk.kind === "dynamic-argument" &&
    /(?:\$[A-Za-z0-9_@*?#$!-]|\$\{|`|\$\(|[<>]\()/u.test(risk.text)
  );
}

function riskInsidePromptOnlyStep(risk: CommandRisk, explanation: CommandExplanation): boolean {
  return [...explanation.topLevelCommands, ...explanation.nestedCommands].some(
    (step) => riskInsideStep(risk, step) && stepReasons(step, explanation.risks).length > 0,
  );
}

function findUnanalyzableRisk(explanation: CommandExplanation): CommandRisk | null {
  return explanation.risks.find((entry) => UNANALYZABLE_RISKS.has(entry.kind)) ?? null;
}

function hasBlockingRisk(
  explanation: CommandExplanation,
): CommandRisk["kind"] | CommandExplanation["shapes"][number] | null {
  const risk = findUnanalyzableRisk(explanation);
  if (risk) {
    return risk.kind;
  }
  const unsupportedShape = explanation.shapes.find((shape) =>
    UNSUPPORTED_DIRECT_SHELL_TOPOLOGY_SHAPES.has(shape),
  );
  if (unsupportedShape) {
    return unsupportedShape;
  }
  const dynamicArgument = explanation.risks.find(
    (entry) =>
      isShellExpansionDynamicArgument(entry) && !riskInsidePromptOnlyStep(entry, explanation),
  );
  if (dynamicArgument) {
    return dynamicArgument.kind;
  }
  return null;
}

function shellWrapperPreludeReasons(params: {
  step: CommandStep;
  risks: readonly CommandRisk[];
}): string[] {
  const reasons = params.risks
    .filter(
      (risk) => UNANALYZABLE_RISKS.has(risk.kind) && riskBeforeStepExecutable(risk, params.step),
    )
    .map((risk) => risk.kind);
  return uniqueStrings(reasons);
}

function isPathScopedExecutableToken(token: string): boolean {
  return token.includes("/") || token.includes("\\");
}

function hasResolvedExecutionPath(segment: ExecCommandSegment): boolean {
  const execution = segment.resolution?.execution;
  return Boolean(execution?.resolvedPath?.trim() || execution?.resolvedRealPath?.trim());
}

function isUnresolvedPathScopedExecutable(segment: ExecCommandSegment): boolean {
  return (
    isPathScopedExecutableToken(segment.argv[0]?.trim() ?? "") && !hasResolvedExecutionPath(segment)
  );
}

export function canUseReusableWrapperPayloadCandidates(
  segments: readonly ExecCommandSegment[],
): boolean {
  const firstExecutable = segments[0]?.argv[0]?.trim() ?? "";
  if (!firstExecutable) {
    return false;
  }
  if (segments.some((segment) => isPathScopedExecutableToken(segment.argv[0]?.trim() ?? ""))) {
    return false;
  }
  return !segments.some((segment) =>
    normalizeExecutableToken(segment.argv[0] ?? "").endsWith("-wrapper"),
  );
}

function isShellExecutable(argv: readonly string[]): boolean {
  const executable = normalizeExecutableToken(argv[0] ?? "");
  return POSIX_SHELL_NAMES.has(executable);
}

function canUseWrapperShellInvocation(segment: ExecCommandSegment): boolean {
  const argv = segment.argv;
  if (isPathScopedExecutableToken(argv[0]?.trim() ?? "")) {
    return false;
  }
  return (
    isShellExecutable(argv) &&
    !hasPosixInteractiveStartupBeforeInlineCommand(argv, POSIX_INLINE_COMMAND_FLAGS) &&
    !hasPosixLoginStartupBeforeInlineCommand(argv, POSIX_INLINE_COMMAND_FLAGS)
  );
}

function wrapperPrefixForStep(step: CommandStep): string {
  const executableStart = Math.max(0, step.executableSpan.startIndex - step.span.startIndex);
  return step.text.slice(0, executableStart);
}

function hasCommandPrelude(step: CommandStep): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(wrapperPrefixForStep(step).trimStart());
}

function positionalCarrierSteps(params: {
  wrapper: CommandStepWithSegment;
  context: PlanningContext;
}): CommandStepWithSegment[] | null {
  const inlineMatch = resolveInlineCommandMatch(
    params.wrapper.segment.argv,
    POSIX_INLINE_COMMAND_FLAGS,
    { allowCombinedC: true },
  );
  if (inlineMatch.valueTokenIndex === null || !inlineMatch.command) {
    return null;
  }
  if (!canUseWrapperShellInvocation(params.wrapper.segment)) {
    return null;
  }
  if (!isDirectShellPositionalCarrierCommand(inlineMatch.command)) {
    return null;
  }
  const carriedArgv = params.wrapper.segment.argv
    .slice(inlineMatch.valueTokenIndex + 1)
    .filter((token) => token.trim().length > 0);
  if (carriedArgv.length === 0) {
    return null;
  }
  const carriedName = normalizeExecutableToken(carriedArgv[0] ?? "");
  if (
    isDispatchWrapperExecutable(carriedName) ||
    POSITIONAL_CARRIER_BLOCKED_EXECUTABLES.has(carriedName) ||
    POSIX_SHELL_NAMES.has(carriedName) ||
    carriedName.endsWith("-wrapper")
  ) {
    return null;
  }
  const raw = carriedArgv.join(" ");
  const carriedSpan = {
    startIndex: params.wrapper.step.span.endIndex,
    endIndex: params.wrapper.step.span.endIndex,
    startPosition: params.wrapper.step.span.endPosition,
    endPosition: params.wrapper.step.span.endPosition,
  };
  const step: CommandStep = {
    context: "wrapper-payload",
    executable: carriedArgv[0] ?? "",
    argv: carriedArgv,
    text: raw,
    span: carriedSpan,
    executableSpan: carriedSpan,
  };
  return [
    {
      step,
      segment: commandSegmentFromArgv(
        carriedArgv,
        params.context,
        params.wrapper.segment.sourceArgv,
      ),
    },
  ];
}

function shouldPersistCandidate(params: {
  segment: ExecCommandSegment;
  relationship: ExecAuthorizationRelationship;
  trustMode: ExecAuthorizationTrustMode;
}): boolean {
  if (params.trustMode !== "executable") {
    return false;
  }
  if (params.relationship === "pipeline" && isShellExecutable(params.segment.argv)) {
    return false;
  }
  return params.segment.resolution?.policyBlocked !== true;
}

function createCandidate(params: {
  step: CommandStep;
  segment: ExecCommandSegment;
  relationship: ExecAuthorizationRelationship;
  transport: ExecAuthorizationTransport;
  risks: readonly CommandRisk[];
}): ExecAuthorizationCandidate {
  const isDirectShellWrapper =
    params.transport.kind === "direct" &&
    extractBindableShellWrapperInlineCommand(params.segment.argv);
  const stepPromptReasons = stepReasons(params.step, params.risks);
  const stepNonReusableReasons = nonReusableStepReasons(params.step, params.risks);
  const preludeReasons = hasCommandPrelude(params.step)
    ? shellWrapperPreludeReasons({ step: params.step, risks: params.risks })
    : [];
  if (hasCommandPrelude(params.step) && preludeReasons.length === 0) {
    preludeReasons.push(SHELL_WRAPPER_PRELUDE_REASON);
  }
  const reasons = uniqueStrings([
    ...stepPromptReasons,
    ...stepNonReusableReasons,
    ...preludeReasons,
  ]);
  const trustMode: ExecAuthorizationTrustMode =
    params.segment.resolution?.policyBlocked === true
      ? "prompt-only"
      : preludeReasons.length > 0
        ? "prompt-only"
        : isDirectShellWrapper
          ? "exact-command"
          : stepPromptReasons.length > 0
            ? "prompt-only"
            : "executable";
  return {
    sourceSegment: params.segment,
    sourceStep: params.step,
    ...(params.step.id ? { sourceStepId: params.step.id } : {}),
    transport: params.transport,
    trustMode,
    allowAlways:
      stepNonReusableReasons.length === 0 &&
      shouldPersistCandidate({
        segment: params.segment,
        relationship: params.relationship,
        trustMode,
      }),
    reasons,
  };
}

function finalizeGroup(params: {
  steps: CommandStepWithSegment[];
  relationship: ExecAuthorizationRelationship;
  opToNext: ShellChainOperator | null;
  transport: ExecAuthorizationTransport;
  risks: readonly CommandRisk[];
}): ExecAuthorizationGroup {
  const relationship = params.steps.length > 1 ? "pipeline" : params.relationship;
  return {
    opToNext: params.opToNext,
    candidates: params.steps.map((entry) =>
      createCandidate({
        step: entry.step,
        segment: entry.segment,
        relationship,
        transport: params.transport,
        risks: params.risks,
      }),
    ),
  };
}

function groupsFromSteps(params: {
  steps: CommandStepWithSegment[];
  operators?: readonly CommandOperator[];
  transport: ExecAuthorizationTransport;
  risks: readonly CommandRisk[];
}): ExecAuthorizationGroup[] {
  const sorted = params.steps.toSorted(
    (left, right) => left.step.span.startIndex - right.step.span.startIndex,
  );
  const groups: ExecAuthorizationGroup[] = [];
  let current: CommandStepWithSegment[] = [];
  const operatorByFromCommandId = new Map<string, AuthorizationOperator>();
  for (const operator of params.operators ?? []) {
    operatorByFromCommandId.set(operator.fromCommandId, authorizationOperatorForTopology(operator));
  }

  if (sorted.length > 1 && operatorByFromCommandId.size === 0) {
    return [
      finalizeGroup({
        steps: sorted,
        relationship: "pipeline",
        opToNext: null,
        transport: params.transport,
        risks: params.risks,
      }),
    ];
  }

  for (const entry of sorted) {
    if (current.length === 0) {
      current = [entry];
      continue;
    }
    const previous = current[current.length - 1];
    if (!previous) {
      current = [entry];
      continue;
    }
    const previousCommandId = previous.step.id;
    const operator = previousCommandId ? operatorByFromCommandId.get(previousCommandId) : undefined;
    if (operator === "pipe") {
      current.push(entry);
      continue;
    }
    const opToNext =
      operator === "&&" || operator === "||" || operator === ";" || operator === "&"
        ? operator
        : ";";
    groups.push(
      finalizeGroup({
        steps: current,
        relationship: "simple",
        opToNext,
        transport: params.transport,
        risks: params.risks,
      }),
    );
    current = [entry];
  }

  if (current.length > 0) {
    groups.push(
      finalizeGroup({
        steps: current,
        relationship: "simple",
        opToNext: null,
        transport: params.transport,
        risks: params.risks,
      }),
    );
  }

  return groups;
}

function shellWrapperRiskForStep(
  step: CommandStep,
  risks: readonly CommandRisk[],
): Extract<CommandRisk, { kind: "shell-wrapper" }> | null {
  const risk = risks.find(
    (entry): entry is Extract<CommandRisk, { kind: "shell-wrapper" }> =>
      entry.kind === "shell-wrapper" && riskInsideStep(entry, step),
  );
  return risk ?? null;
}

function shouldUseWrapperPayload(params: {
  wrapperCommandId?: string;
  topLevelSteps: readonly CommandStepWithSegment[];
  nestedSteps: readonly CommandStepWithSegment[];
  risks: readonly CommandRisk[];
}): boolean {
  if (params.topLevelSteps.length !== 1 || params.nestedSteps.length === 0) {
    return false;
  }
  const wrapperStep = params.topLevelSteps[0]?.step;
  if (!wrapperStep || !shellWrapperRiskForStep(wrapperStep, params.risks)) {
    return false;
  }
  const nestedStepsForWrapper = params.wrapperCommandId
    ? params.nestedSteps.filter((entry) => entry.step.parentCommandId === params.wrapperCommandId)
    : params.nestedSteps;
  return canUseReusableWrapperPayloadCandidates(
    nestedStepsForWrapper.map((entry) => entry.segment),
  );
}

function applyWrapperPayloadPersistenceBoundary(params: {
  wrapper: CommandStepWithSegment;
  groups: ExecAuthorizationGroup[];
}): ExecAuthorizationGroup[] {
  if (!isUnresolvedPathScopedExecutable(params.wrapper.segment)) {
    return params.groups;
  }
  return params.groups.map((group) => ({
    ...group,
    candidates: group.candidates.map((candidate) => ({
      ...candidate,
      allowAlways: false,
    })),
  }));
}

function wrapperPayloadPlan(params: {
  context: PlanningContext;
  allowNestedPayload: boolean;
  topLevelSteps: CommandStepWithSegment[];
  nestedSteps: CommandStepWithSegment[];
  operators: readonly CommandOperator[];
  risks: readonly CommandRisk[];
}): ExecAuthorizationGroup[] | null {
  const wrapper = params.topLevelSteps[0];
  if (!wrapper) {
    return null;
  }
  const wrapperRisk = shellWrapperRiskForStep(wrapper.step, params.risks);
  if (!wrapperRisk) {
    return null;
  }
  if (hasCommandPrelude(wrapper.step)) {
    return null;
  }
  if (!canUseWrapperShellInvocation(wrapper.segment)) {
    return null;
  }
  if (!params.allowNestedPayload) {
    return null;
  }
  const carriedSteps = positionalCarrierSteps({ wrapper, context: params.context });
  if (carriedSteps) {
    const transport: ExecAuthorizationTransport = {
      kind: "shell-wrapper",
      wrapperSegment: wrapper.segment,
      wrapperArgv: wrapper.segment.argv,
      wrapperPrefix: wrapperPrefixForStep(wrapper.step),
      inlineCommand: wrapperRisk.payload,
    };
    const groups = groupsFromSteps({
      steps: carriedSteps,
      transport,
      risks: params.risks,
    });
    return groups.length > 0 ? applyWrapperPayloadPersistenceBoundary({ wrapper, groups }) : null;
  }
  if (
    !shouldUseWrapperPayload({
      wrapperCommandId: wrapper.step.id,
      topLevelSteps: params.topLevelSteps,
      nestedSteps: params.nestedSteps,
      risks: params.risks,
    })
  ) {
    return null;
  }
  const transport: ExecAuthorizationTransport = {
    kind: "shell-wrapper",
    wrapperSegment: wrapper.segment,
    wrapperArgv: wrapper.segment.argv,
    wrapperPrefix: wrapperPrefixForStep(wrapper.step),
    inlineCommand: wrapperRisk.payload,
  };
  const nestedStepsForWrapper = wrapper.step.id
    ? params.nestedSteps.filter((entry) => entry.step.parentCommandId === wrapper.step.id)
    : params.nestedSteps;
  const operatorsForWrapper = wrapper.step.id
    ? params.operators.filter((operator) => operator.parentCommandId === wrapper.step.id)
    : params.operators;
  const groups = groupsFromSteps({
    steps: nestedStepsForWrapper,
    operators: operatorsForWrapper,
    transport,
    risks: params.risks,
  });
  return groups.length > 0 ? applyWrapperPayloadPersistenceBoundary({ wrapper, groups }) : null;
}

function dialectForArgv(argv: readonly string[]): ExecAuthorizationDialect {
  const executable = normalizeExecutableToken(argv[0] ?? "");
  if (POWERSHELL_NAMES.has(executable)) {
    return "powershell";
  }
  if (WINDOWS_CMD_NAMES.has(executable)) {
    return "windows-cmd";
  }
  return "argv";
}

function unanalyzablePlan(params: {
  dialect: ExecAuthorizationDialect;
  command: string;
  reason: string;
}): ExecAuthorizationPlan {
  return {
    ok: false,
    dialect: params.dialect,
    originalCommand: params.command,
    reason: params.reason,
    groups: [],
    operators: [],
  };
}

function planFromExplanation(params: {
  command: string;
  explanation: CommandExplanation;
  context: PlanningContext;
}): ExecAuthorizationPlan {
  const topLevelSteps = params.explanation.topLevelCommands.map((step) => ({
    step,
    segment: commandSegmentFromStep(step, params.context),
  }));
  const nestedSteps = params.explanation.nestedCommands
    .filter((step) => step.context === "wrapper-payload")
    .map((step) => ({
      step,
      segment: commandSegmentFromStep(step, params.context),
    }));
  const blockingRisk = hasBlockingRisk(params.explanation);
  const unanalyzableRisk = findUnanalyzableRisk(params.explanation);
  const topLevelStep = topLevelSteps[0]?.step;
  const canFallBackToExactWrapper =
    topLevelSteps.length === 1 &&
    Boolean(
      topLevelStep &&
      shellWrapperRiskForStep(topLevelStep, params.explanation.risks) &&
      (!unanalyzableRisk || riskInsideStep(unanalyzableRisk, topLevelStep)),
    );
  if (!params.explanation.ok || (blockingRisk && !canFallBackToExactWrapper)) {
    return unanalyzablePlan({
      dialect: "posix-shell",
      command: params.command,
      reason: blockingRisk ?? "unable to parse command",
    });
  }

  const payloadPlan = wrapperPayloadPlan({
    context: params.context,
    allowNestedPayload:
      !blockingRisk &&
      !params.explanation.shapes.some((shape) =>
        UNSUPPORTED_DIRECT_SHELL_TOPOLOGY_SHAPES.has(shape),
      ),
    topLevelSteps,
    nestedSteps,
    operators: params.explanation.operators ?? [],
    risks: params.explanation.risks,
  });
  const groups =
    payloadPlan ??
    groupsFromSteps({
      steps: topLevelSteps,
      operators: (params.explanation.operators ?? []).filter(
        (operator) => operator.parentCommandId === undefined,
      ),
      transport: { kind: "direct" },
      risks: params.explanation.risks,
    });
  if (groups.length === 0) {
    return unanalyzablePlan({
      dialect: "posix-shell",
      command: params.command,
      reason: "no commands to authorize",
    });
  }
  return {
    ok: true,
    dialect: "posix-shell",
    originalCommand: params.command,
    groups,
    operators: params.explanation.operators ?? [],
  };
}

export async function planShellAuthorization(params: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
}): Promise<ExecAuthorizationPlan> {
  if (params.platform === "win32") {
    return unanalyzablePlan({
      dialect: "windows-cmd",
      command: params.command,
      reason: "non-POSIX shell command",
    });
  }
  try {
    const explanation = await explainShellCommand(params.command);
    return planFromExplanation({
      command: params.command,
      explanation,
      context: {
        cwd: params.cwd,
        env: params.env,
        platform: normalizePlanningPlatform(params.platform),
      },
    });
  } catch (error) {
    return unanalyzablePlan({
      dialect: "posix-shell",
      command: params.command,
      reason: error instanceof Error ? error.message : "unable to parse command",
    });
  }
}

export async function planExecAuthorization(params: {
  analysis: ExecCommandAnalysis;
  command?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
}): Promise<ExecAuthorizationPlan> {
  const command =
    params.command ??
    params.analysis.segments
      .map((segment) => segment.raw)
      .join(params.analysis.chains ? " && " : " | ");
  if (!params.analysis.ok) {
    return unanalyzablePlan({
      dialect: "argv",
      command,
      reason: params.analysis.reason ?? "unable to parse command",
    });
  }

  const argv = params.analysis.segments[0]?.argv ?? [];
  const dialect = dialectForArgv(argv);
  if (dialect !== "argv") {
    return unanalyzablePlan({
      dialect,
      command,
      reason: "non-POSIX command wrapper",
    });
  }

  if (params.analysis.segments.length === 1) {
    const wrapperSegment = params.analysis.segments[0];
    const inlineCommand = extractBindableShellWrapperInlineCommand(argv);
    if (inlineCommand && wrapperSegment && canUseWrapperShellInvocation(wrapperSegment)) {
      const shellPlan = await planShellAuthorization({
        command: inlineCommand,
        cwd: params.cwd,
        env: params.env,
        platform: params.platform,
      });
      if (shellPlan.ok) {
        const nestedSegments = shellPlan.groups.flatMap((group) =>
          group.candidates.map((candidate) => candidate.sourceSegment),
        );
        if (wrapperSegment && canUseReusableWrapperPayloadCandidates(nestedSegments)) {
          const persistNestedPayloads = !isUnresolvedPathScopedExecutable(wrapperSegment);
          const groups = shellPlan.groups.map((group) => ({
            ...group,
            candidates: group.candidates.map((candidate) => {
              const transport: ExecAuthorizationTransport = {
                kind: "shell-wrapper",
                wrapperSegment,
                wrapperArgv: wrapperSegment.argv,
                wrapperPrefix: "",
                inlineCommand,
              };
              return {
                ...candidate,
                transport,
                allowAlways: persistNestedPayloads ? candidate.allowAlways : false,
              };
            }),
          }));
          return {
            ok: true,
            dialect: "argv",
            originalCommand: command,
            groups,
            operators: shellPlan.operators,
          };
        }
      }
    }
  }

  const steps = params.analysis.segments.map((segment, index) => ({
    step: {
      context: "top-level" as const,
      executable: segment.argv[0] ?? "",
      argv: segment.argv,
      text: segment.raw,
      span: {
        startIndex: index,
        endIndex: index + segment.raw.length,
        startPosition: { row: 0, column: index },
        endPosition: { row: 0, column: index + segment.raw.length },
      },
      executableSpan: {
        startIndex: index,
        endIndex: index + (segment.argv[0]?.length ?? 0),
        startPosition: { row: 0, column: index },
        endPosition: { row: 0, column: index + (segment.argv[0]?.length ?? 0) },
      },
    },
    segment:
      segment.resolution === null
        ? commandSegmentFromArgv(
            segment.argv,
            {
              cwd: params.cwd,
              env: params.env,
              platform: normalizePlanningPlatform(params.platform),
            },
            segment.sourceArgv,
          )
        : segment,
  }));
  const groups = groupsFromSteps({
    steps,
    transport: { kind: "direct" },
    risks: [],
  });
  return {
    ok: true,
    dialect: "argv",
    originalCommand: command,
    groups,
    operators: [],
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
