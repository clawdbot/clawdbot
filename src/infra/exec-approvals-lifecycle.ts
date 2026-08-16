// Classifies OpenClaw self-lifecycle mutations before generic exec trust can apply.
import { splitShellArgs } from "../utils/shell-argv.js";
import { resolveCarrierCommandArgv } from "./command-carriers.js";
import { unwrapKnownDispatchWrapperInvocation } from "./dispatch-wrapper-resolution.js";
import { resolveLifecycleXargsArgv } from "./exec-approvals-lifecycle-carriers.js";
import {
  classifyOpenClawArgv,
  lifecycleFirstPositional as scanFirstPositional,
  lifecycleHasEffectiveHelpOrVersion as hasEffectiveHelpOrVersion,
  lifecycleHasHelpOrVersion as hasHelpOrVersion,
} from "./exec-approvals-lifecycle-cli.js";
import {
  expandLifecycleEnvironmentArgv,
  lifecycleAssignedEnvironmentKeys,
  lifecycleCommandHasUnquotedEnvironmentReference,
  lifecycleCommandShellDialect,
  powerShellCalculatedArgvMayHideLifecycle,
  unresolvedEnvironmentMayHideLifecycle,
} from "./exec-approvals-lifecycle-env.js";
import { resolveNodeOpenClawArgv } from "./exec-approvals-lifecycle-node.js";
import {
  isOpenClawExecutablePattern,
  matchesLifecycleExecutablePattern,
  matchesOpenClawProcessPattern,
  matchesOpenClawUnitPattern,
} from "./exec-approvals-lifecycle-patterns.js";
import {
  commandHasPowerShellLifecyclePipeline as pipelineNeedsApproval,
  powerShellArgvUsesWhatIf,
  powerShellAliasLifecycleInvocationRequiresApproval as powerShellAliasNeedsApproval,
  powerShellDirectObjectMutationRequiresApproval,
  resolvePowerShellStartProcessOpenClawArgv,
} from "./exec-approvals-lifecycle-powershell.js";
import { resolveLifecyclePackageRunnerArgv } from "./exec-approvals-lifecycle-runners.js";
import {
  lifecycleControlArgvRequiresApproval,
  posixCommandBindingRequiresApproval as posixBindingNeedsApproval,
  powerShellCalculatedInvocationRequiresApproval,
  splitLifecycleInlineCommands,
  stripLifecyclePosixAssignments,
  unwrapLifecycleControlArgv,
} from "./exec-approvals-lifecycle-shell.js";
import {
  bindLifecyclePosixShellPositionals,
  extractShellSubstitutionCommands,
  lifecycleFunctionLocalPositionalsRequireApproval,
  lifecyclePositionalBindingRequiresApproval,
  lifecycleSubstitutionSelectsOpenClawProcess,
  lifecycleSubstitutionResultMayHideLifecycle,
  resolveLifecyclePosixShellPositionals,
} from "./exec-approvals-lifecycle-substitutions.js";
import {
  classifySystemctlArgv as classifySystemctl,
  lifecycleArgvUsesSignalZero as argvUsesSignalZero,
} from "./exec-approvals-lifecycle-systemctl.js";
import { lifecycleOptionName as optionName } from "./exec-approvals-lifecycle-tokens.js";
import type { ExecCommandSegment } from "./exec-command-analysis-types.js";
import { normalizeExecutableToken } from "./exec-wrapper-tokens.js";
import { extractShellWrapperInlineCommand } from "./shell-wrapper-resolution.js";

const MAX_NESTED_COMMAND_DEPTH = 8;
const LAUNCHCTL_MUTATIONS = new Set([
  "attach",
  "bootstrap",
  "bootout",
  "debug",
  "disable",
  "enable",
  "kickstart",
  "kill",
  "load",
  "remove",
  "start",
  "stop",
  "submit",
  "unload",
]);
const POWERSHELL_SERVICE_MUTATIONS = new Set([
  "new-service",
  "remove-service",
  "restart-service",
  "resume-service",
  "set-service",
  "start-service",
  "stop-process",
  "stop-service",
  "suspend-service",
  "spps",
  "spsv",
  "sasv",
]);

type LifecycleSegment = Pick<ExecCommandSegment, "argv"> &
  Partial<Pick<ExecCommandSegment, "raw" | "resolution" | "sourceArgv">>;

type LifecycleEnvironmentContext = {
  env?: NodeJS.ProcessEnv;
  envComplete: boolean;
  platform: NodeJS.Platform;
  shadowedKeys: ReadonlySet<string>;
};

function normalizedToken(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replaceAll("`", "").replaceAll("^", "");
}

function looksLikeOpenClaw(value: string | undefined): boolean {
  const normalized = normalizedToken(value)
    .replace(/\[([a-z0-9])\]/giu, "$1")
    .replace(/["']/gu, "");
  return normalized.includes("openclaw") || /opencla[?*]/u.test(normalized);
}

function isOpenClawExecutable(value: string | undefined): boolean {
  return isOpenClawExecutablePattern(value);
}

function unresolvedDepthMayHideLifecycle(argv: readonly string[]): boolean {
  return (
    argv.some(looksLikeOpenClaw) &&
    /\b(?:daemon|gateway|install|kill|remove|restart|start|stop|uninstall|update)\b/iu.test(
      argv.join(" "),
    )
  );
}

function classifyLaunchctl(
  argv: readonly string[],
  raw: string,
  depth: number,
  shellContext?: ShellContext,
  cwd?: string,
  environment?: LifecycleEnvironmentContext,
  substitutionTokensAreSyntax = true,
): boolean {
  const optionsWithValue = new Set(["-d", "-s"]);
  if (hasEffectiveHelpOrVersion(argv, 1, optionsWithValue)) {
    return false;
  }
  const actionIndex = scanFirstPositional(argv, 1, optionsWithValue);
  const action = normalizedToken(argv[actionIndex]);
  if (["asuser", "bsexec"].includes(action)) {
    const commandArgv = argv.slice(actionIndex + 2);
    return (
      commandArgv.length > 0 &&
      classifyArgv(
        commandArgv,
        raw,
        depth + 1,
        shellContext,
        cwd,
        environment,
        substitutionTokensAreSyntax,
      )
    );
  }
  if (!LAUNCHCTL_MUTATIONS.has(action)) {
    return false;
  }
  return argv.slice(actionIndex + 1).some(matchesOpenClawUnitPattern);
}

function classifyServiceManager(argv: readonly string[]): boolean {
  const matchesExecutable = (...names: string[]) =>
    matchesLifecycleExecutablePattern(argv[0], new Set(names));
  if (matchesExecutable("service")) {
    const action = normalizedToken(argv[2]);
    return (
      looksLikeOpenClaw(argv[1]) &&
      (action === "--full-restart" ||
        ["force-reload", "reload", "restart", "start", "stop", "try-restart"].includes(action))
    );
  }
  if (matchesExecutable("sc")) {
    const actionIndex = argv[1]?.startsWith("\\\\") ? 2 : 1;
    return (
      [
        "config",
        "continue",
        "control",
        "create",
        "delete",
        "description",
        "failure",
        "failureflag",
        "managedaccount",
        "pause",
        "preferrednode",
        "privs",
        "sdset",
        "sidtype",
        "start",
        "stop",
        "triggerinfo",
      ].includes(normalizedToken(argv[actionIndex])) &&
      argv.slice(actionIndex + 1).some(looksLikeOpenClaw)
    );
  }
  if (matchesExecutable("net")) {
    return (
      ["continue", "pause", "start", "stop"].includes(normalizedToken(argv[1])) &&
      argv.slice(2).some(looksLikeOpenClaw)
    );
  }
  return false;
}

function classifyScheduledTask(argv: readonly string[]): boolean {
  if (hasHelpOrVersion(argv) || argv.some((token) => normalizedToken(token) === "/?")) {
    return false;
  }
  const mutation = argv.some((token) =>
    ["/change", "/create", "/delete", "/end", "/run"].includes(optionName(token)),
  );
  return mutation && argv.some(looksLikeOpenClaw);
}

type ShellContext = "cmd" | "powershell" | undefined;

function classifyProcessMutation(
  argv: readonly string[],
  raw: string,
  shellContext: ShellContext,
): boolean {
  const executable = normalizeExecutableToken(argv[0] ?? "");
  const matchesExecutable = (...names: string[]) =>
    matchesLifecycleExecutablePattern(argv[0], new Set(names));
  if (shellContext === "powershell" && powerShellDirectObjectMutationRequiresApproval(raw, argv)) {
    return true;
  }
  if (shellContext === "powershell" && powerShellArgvUsesWhatIf(argv)) {
    return false;
  }
  const pkill = matchesExecutable("pkill");
  if (pkill || matchesExecutable("killall")) {
    if (hasHelpOrVersion(argv, new Set(["-l", "--list"])) || argvUsesSignalZero(argv, !pkill)) {
      return false;
    }
    return argv.slice(1).some(matchesOpenClawProcessPattern);
  }
  if (matchesExecutable("taskkill")) {
    return (
      !argv.some((token) => normalizedToken(token) === "/?") &&
      argv.some(matchesOpenClawProcessPattern)
    );
  }
  if (matchesExecutable("kill")) {
    if (shellContext === "powershell") {
      return argv.slice(1).some(matchesOpenClawProcessPattern);
    }
    if (hasHelpOrVersion(argv, new Set(["-l"])) || argvUsesSignalZero(argv)) {
      return false;
    }
    const normalizedRaw = raw
      .replace(/\[([a-z0-9])\]/giu, "$1")
      .replace(/''|""/gu, "")
      .replace(/\\([a-z0-9])/giu, "$1");
    const substitutionSelectsOpenClaw = [raw, ...argv.slice(1)].some(
      lifecycleSubstitutionSelectsOpenClawProcess,
    );
    return (
      substitutionSelectsOpenClaw ||
      /\b(?:pgrep|pidof)\b[\s\S]{0,120}\bopenclaw\b/iu.test(normalizedRaw) ||
      /\$\([^)]*\bopenclaw\b[^)]*\)|`[^`]*\bopenclaw\b[^`]*`/iu.test(normalizedRaw)
    );
  }
  if (
    POWERSHELL_SERVICE_MUTATIONS.has(executable) ||
    matchesLifecycleExecutablePattern(argv[0], POWERSHELL_SERVICE_MUTATIONS)
  ) {
    return argv.slice(1).some(matchesOpenClawProcessPattern);
  }
  return false;
}

function commandHasLifecycleSubstitution(
  command: string,
  depth: number,
  shellContext?: ShellContext,
  cwd?: string,
  environment?: LifecycleEnvironmentContext,
): boolean {
  const scan = extractShellSubstitutionCommands(command, shellContext ?? "posix");
  if (scan.uncertain) {
    return true;
  }
  return scan.commands.some((nested) =>
    splitLifecycleInlineCommands(nested, shellContext ?? "posix").some((part) => {
      const argv = splitShellArgs(part);
      if (!argv) {
        return true;
      }
      if (!environment) {
        return classifyArgv(argv, part, depth + 1, shellContext, cwd);
      }
      const dialect = shellContext ?? "posix";
      const expanded = expandLifecycleEnvironmentArgv({
        argv,
        env: environment.env,
        envComplete: environment.envComplete,
        dialect,
        platform: environment.platform,
        shadowedKeys: environment.shadowedKeys,
      });
      return (
        ((expanded.unresolved ||
          (expanded.fieldSplitUncertain &&
            lifecycleCommandHasUnquotedEnvironmentReference(part, dialect))) &&
          unresolvedEnvironmentMayHideLifecycle(argv)) ||
        classifyArgv(expanded.argv, part, depth + 1, shellContext, cwd, environment, false)
      );
    }),
  );
}

function classifyArgv(
  argv: string[],
  raw: string,
  depth: number,
  shellContext?: ShellContext,
  cwd?: string,
  environment?: LifecycleEnvironmentContext,
  substitutionTokensAreSyntax = true,
): boolean {
  if (argv.length === 0) {
    return false;
  }
  const dialect = shellContext ?? "posix";
  if (
    lifecycleControlArgvRequiresApproval(argv, dialect) ||
    (dialect === "powershell" && powerShellCalculatedInvocationRequiresApproval(raw))
  ) {
    return true;
  }
  const controlArgv = unwrapLifecycleControlArgv(argv, dialect);
  if (controlArgv) {
    return (
      controlArgv.length > 0 &&
      classifyArgv(
        controlArgv,
        raw,
        depth + 1,
        shellContext,
        cwd,
        environment,
        substitutionTokensAreSyntax,
      )
    );
  }
  if (shellContext === undefined) {
    const commandArgv = stripLifecyclePosixAssignments(argv);
    if (commandArgv?.length === 0) {
      return false;
    }
    if (commandArgv) {
      return classifyArgv(
        commandArgv,
        raw,
        depth,
        shellContext,
        cwd,
        environment,
        substitutionTokensAreSyntax,
      );
    }
  }
  if (
    substitutionTokensAreSyntax &&
    lifecycleSubstitutionResultMayHideLifecycle(argv, shellContext ?? "posix")
  ) {
    return true;
  }
  if (isOpenClawExecutable(argv[0])) {
    return (
      (shellContext === "powershell" && powerShellCalculatedArgvMayHideLifecycle(argv)) ||
      classifyOpenClawArgv(["openclaw", ...argv.slice(1)])
    );
  }
  if (depth >= MAX_NESTED_COMMAND_DEPTH) {
    return unresolvedDepthMayHideLifecycle(argv);
  }

  const carried = resolveCarrierCommandArgv(argv, depth, { includeExec: true });
  if (carried?.length) {
    return classifyArgv(
      carried,
      carried.join(" "),
      depth + 1,
      shellContext,
      cwd,
      environment,
      substitutionTokensAreSyntax,
    );
  }
  const dispatch = unwrapKnownDispatchWrapperInvocation(argv);
  if (dispatch.kind === "unwrapped" && dispatch.argv.length > 0) {
    return classifyArgv(
      dispatch.argv,
      dispatch.argv.join(" "),
      depth + 1,
      shellContext,
      cwd,
      environment,
      substitutionTokensAreSyntax,
    );
  }

  const rawInline = extractShellWrapperInlineCommand(argv);
  if (rawInline !== null) {
    const wrapper = normalizeExecutableToken(argv[0] ?? "");
    const nestedShellContext: ShellContext =
      wrapper === "cmd"
        ? "cmd"
        : ["powershell", "pwsh"].includes(wrapper)
          ? "powershell"
          : undefined;
    const nestedDialect = nestedShellContext ?? "posix";
    const nestedShadowedKeys = environment
      ? new Set([...environment.shadowedKeys, ...lifecycleAssignedEnvironmentKeys(rawInline)])
      : new Set<string>();
    const nestedEnvironment = environment
      ? { ...environment, shadowedKeys: nestedShadowedKeys }
      : undefined;
    const expandNestedPowerShellArgv = environment
      ? (pipelineArgv: string[]) =>
          expandLifecycleEnvironmentArgv({
            argv: pipelineArgv,
            env: environment.env,
            envComplete: environment.envComplete,
            dialect: "powershell",
            platform: environment.platform,
            shadowedKeys: nestedShadowedKeys,
          })
      : undefined;
    const classifyNested = (nestedArgv: string[], nestedRaw: string) =>
      classifyArgv(nestedArgv, nestedRaw, depth + 1, nestedShellContext, cwd, nestedEnvironment);
    if (
      nestedShellContext === "powershell" &&
      (powerShellCalculatedInvocationRequiresApproval(rawInline) ||
        powerShellAliasNeedsApproval(rawInline, expandNestedPowerShellArgv, classifyNested) ||
        pipelineNeedsApproval(
          rawInline,
          environment ? !environment.envComplete : false,
          expandNestedPowerShellArgv,
          classifyNested,
        ))
    ) {
      return true;
    }
    if (
      (nestedDialect === "posix" && posixBindingNeedsApproval(rawInline, classifyNested)) ||
      lifecycleFunctionLocalPositionalsRequireApproval(rawInline)
    ) {
      return true;
    }
    if (
      commandHasLifecycleSubstitution(rawInline, depth, nestedShellContext, cwd, nestedEnvironment)
    ) {
      return true;
    }
    const positionalArgv = resolveLifecyclePosixShellPositionals(argv);
    return splitLifecycleInlineCommands(rawInline, nestedDialect).some((part) => {
      const rawNestedArgv = splitShellArgs(part);
      if (!rawNestedArgv) {
        return false;
      }
      const expandedNested = environment
        ? expandLifecycleEnvironmentArgv({
            argv: rawNestedArgv,
            env: environment.env,
            envComplete: environment.envComplete,
            dialect: nestedDialect,
            platform: environment.platform,
            shadowedKeys: nestedShadowedKeys,
          })
        : { argv: rawNestedArgv, fieldSplitUncertain: false, unresolved: false };
      if (
        (expandedNested.unresolved ||
          (expandedNested.fieldSplitUncertain &&
            lifecycleCommandHasUnquotedEnvironmentReference(part, nestedDialect))) &&
        unresolvedEnvironmentMayHideLifecycle(rawNestedArgv)
      ) {
        return true;
      }
      if (
        positionalArgv !== null &&
        lifecyclePositionalBindingRequiresApproval(part, positionalArgv)
      ) {
        return true;
      }
      const boundArgv =
        positionalArgv === null
          ? expandedNested.argv
          : bindLifecyclePosixShellPositionals(expandedNested.argv, positionalArgv);
      return classifyArgv(
        boundArgv,
        part,
        depth + 1,
        nestedShellContext,
        cwd,
        nestedEnvironment,
        false,
      );
    });
  }

  const xargs = resolveLifecycleXargsArgv(argv);
  if (xargs.kind === "approval-required") {
    return true;
  }
  if (xargs.kind === "argv") {
    return classifyArgv(
      xargs.argv,
      xargs.argv.join(" "),
      depth + 1,
      shellContext,
      cwd,
      environment,
      substitutionTokensAreSyntax,
    );
  }

  const packageRunner = resolveLifecyclePackageRunnerArgv(argv);
  if (packageRunner.kind === "approval-required") {
    return true;
  }
  if (packageRunner.kind === "argv") {
    return classifyArgv(
      packageRunner.argv,
      packageRunner.argv.join(" "),
      depth + 1,
      shellContext,
      cwd,
      environment,
      substitutionTokensAreSyntax,
    );
  }
  const nodeArgv = resolveNodeOpenClawArgv(argv, cwd);
  if (nodeArgv) {
    return classifyOpenClawArgv(nodeArgv);
  }
  const powerShellStartArgv =
    shellContext === "powershell" ? resolvePowerShellStartProcessOpenClawArgv(argv) : null;
  if (powerShellStartArgv) {
    return classifyOpenClawArgv(powerShellStartArgv);
  }

  if (matchesLifecycleExecutablePattern(argv[0], new Set(["launchctl"]))) {
    return classifyLaunchctl(
      argv,
      raw,
      depth,
      shellContext,
      cwd,
      environment,
      substitutionTokensAreSyntax,
    );
  }
  if (matchesLifecycleExecutablePattern(argv[0], new Set(["systemctl"]))) {
    return classifySystemctl(argv);
  }
  if (matchesLifecycleExecutablePattern(argv[0], new Set(["schtasks"]))) {
    return classifyScheduledTask(argv);
  }
  return classifyServiceManager(argv) || classifyProcessMutation(argv, raw, shellContext);
}

/** Return true when generic exec trust must not authorize an OpenClaw self-mutation. */
export function commandRequiresOpenClawLifecycleApproval(params: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  envComplete?: boolean;
  platform?: NodeJS.Platform;
  segments: LifecycleSegment[];
}): boolean {
  const envComplete = params.envComplete ?? params.env !== undefined;
  const platform = params.platform ?? process.platform;
  const shadowedKeys = lifecycleAssignedEnvironmentKeys(params.command);
  const environment: LifecycleEnvironmentContext = {
    env: params.env,
    envComplete,
    platform,
    shadowedKeys,
  };
  const dialect = lifecycleCommandShellDialect(undefined, platform);
  const expandPowerShellArgv = (argv: string[]) =>
    expandLifecycleEnvironmentArgv({
      argv,
      env: params.env,
      envComplete,
      dialect: "powershell",
      platform,
      shadowedKeys,
    });
  const shellContext: ShellContext = platform === "win32" ? "powershell" : undefined;
  const classifyTop = (argv: string[], raw: string) =>
    classifyArgv(argv, raw, 0, shellContext, params.cwd, environment);
  if (
    (dialect === "posix" && posixBindingNeedsApproval(params.command, classifyTop)) ||
    (dialect === "powershell" &&
      powerShellAliasNeedsApproval(params.command, expandPowerShellArgv, classifyTop)) ||
    pipelineNeedsApproval(params.command, !envComplete, expandPowerShellArgv, classifyTop) ||
    commandHasLifecycleSubstitution(params.command, 0, shellContext, params.cwd, environment)
  ) {
    return true;
  }
  for (const segment of params.segments) {
    const resolvedExecutable =
      segment.resolution?.execution.resolvedRealPath ??
      segment.resolution?.execution.resolvedPath ??
      "";
    const effectiveArgv = segment.resolution?.effectiveArgv ?? segment.argv;
    const resolvedArgv = resolvedExecutable
      ? [resolvedExecutable, ...effectiveArgv.slice(1)]
      : undefined;
    const candidates = [
      resolvedArgv,
      segment.resolution?.effectiveArgv,
      segment.sourceArgv,
      segment.argv,
    ].filter((argv): argv is string[] => Array.isArray(argv) && argv.length > 0);
    if (resolvedExecutable && isOpenClawExecutable(resolvedExecutable)) {
      if (classifyOpenClawArgv(["openclaw", ...effectiveArgv.slice(1)])) {
        return true;
      }
    }
    if (
      candidates.some((argv) => {
        const candidateDialect = lifecycleCommandShellDialect(argv[0], platform);
        const candidateShellContext: ShellContext =
          candidateDialect === "posix" ? undefined : candidateDialect;
        const segmentCommand = segment.raw ?? params.command;
        if (
          (candidateShellContext === "powershell" &&
            pipelineNeedsApproval(segmentCommand, !envComplete, expandPowerShellArgv)) ||
          commandHasLifecycleSubstitution(
            segmentCommand,
            0,
            candidateShellContext,
            params.cwd,
            environment,
          )
        ) {
          return true;
        }
        if (lifecycleSubstitutionResultMayHideLifecycle(argv, candidateDialect)) {
          return true;
        }
        if (
          extractShellWrapperInlineCommand(argv) !== null &&
          classifyArgv(argv, segmentCommand, 0, candidateShellContext, params.cwd, environment)
        ) {
          return true;
        }
        const expanded = expandLifecycleEnvironmentArgv({
          argv,
          env: params.env,
          envComplete,
          dialect: candidateDialect,
          platform,
          shadowedKeys,
        });
        return (
          ((expanded.unresolved ||
            (expanded.fieldSplitUncertain &&
              lifecycleCommandHasUnquotedEnvironmentReference(segmentCommand, candidateDialect))) &&
            unresolvedEnvironmentMayHideLifecycle(argv)) ||
          classifyArgv(
            expanded.argv,
            segmentCommand,
            0,
            candidateShellContext,
            params.cwd,
            environment,
            false,
          )
        );
      })
    ) {
      return true;
    }
  }
  return params.segments.length > 0
    ? false
    : splitLifecycleInlineCommands(params.command, dialect).some((part) => {
        const argv = splitShellArgs(part);
        if (!argv) {
          return false;
        }
        const partDialect = lifecycleCommandShellDialect(argv[0], platform);
        const partShellContext: ShellContext = partDialect === "posix" ? undefined : partDialect;
        if (lifecycleSubstitutionResultMayHideLifecycle(argv, partDialect)) {
          return true;
        }
        if (
          extractShellWrapperInlineCommand(argv) !== null &&
          classifyArgv(argv, part, 0, partShellContext, params.cwd, environment)
        ) {
          return true;
        }
        const expandedArgv = expandLifecycleEnvironmentArgv({
          argv,
          env: params.env,
          envComplete,
          dialect: partDialect,
          platform,
          shadowedKeys,
        });
        return (
          ((expandedArgv.unresolved ||
            (expandedArgv.fieldSplitUncertain &&
              lifecycleCommandHasUnquotedEnvironmentReference(part, partDialect))) &&
            unresolvedEnvironmentMayHideLifecycle(argv)) ||
          classifyArgv(expandedArgv.argv, part, 0, partShellContext, params.cwd, environment, false)
        );
      });
}
