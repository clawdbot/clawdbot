// Classifies systemctl mutations that target OpenClaw units.
import {
  lifecycleFirstPositional,
  lifecycleHasEffectiveHelpOrVersion,
} from "./exec-approvals-lifecycle-cli.js";
import { matchesOpenClawUnitPattern } from "./exec-approvals-lifecycle-patterns.js";

const SYSTEMCTL_MUTATIONS = new Set([
  "add-requires",
  "add-wants",
  "bind",
  "cancel",
  "clean",
  "disable",
  "edit",
  "enable",
  "force-reload",
  "freeze",
  "import-environment",
  "isolate",
  "kill",
  "link",
  "mask",
  "preset",
  "reenable",
  "reload",
  "reload-or-restart",
  "reload-or-try-restart",
  "reset-failed",
  "remove-requires",
  "remove-wants",
  "restart",
  "revert",
  "set-default",
  "set-environment",
  "set-property",
  "start",
  "stop",
  "thaw",
  "try-reload-or-restart",
  "try-restart",
  "unmask",
  "unset-environment",
]);
const SYSTEMCTL_OPTIONS_WITH_VALUE = new Set([
  "-h",
  "-m",
  "-p",
  "-s",
  "-t",
  "--host",
  "--image-policy",
  "--job-mode",
  "--lines",
  "--machine",
  "--output",
  "--property",
  "--root",
  "--runtime-scope",
  "--signal",
  "--state",
  "--type",
]);
const SHORT_SIGNAL_OPTION_RE =
  /^-(?:[1-9][0-9]*|(?:sig)?(?:abrt|alrm|bus|chld|cont|fpe|hup|ill|int|io|kill|pipe|prof|pwr|quit|segv|stop|sys|term|trap|tstp|ttin|ttou|urg|usr1|usr2|vtalrm|winch|xcpu|xfsz))$/iu;

function normalizedToken(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replaceAll("`", "").replaceAll("^", "");
}

export function lifecycleArgvUsesSignalZero(
  argv: readonly string[],
  shortSignalOptionIsSignal = true,
): boolean {
  let effectiveSignal: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      break;
    }
    const lower = normalizedToken(token);
    if (lower === "-0") {
      effectiveSignal = "0";
    } else if (shortSignalOptionIsSignal && lower.startsWith("-s") && lower.length > 2) {
      effectiveSignal = lower.slice(2);
    } else if (lower.startsWith("--signal=")) {
      effectiveSignal = lower.slice("--signal=".length);
    } else if ((shortSignalOptionIsSignal && lower === "-s") || lower === "--signal") {
      effectiveSignal = normalizedToken(argv[index + 1]);
      index += 1;
    } else if (SHORT_SIGNAL_OPTION_RE.test(lower)) {
      effectiveSignal = lower.slice(1);
    }
  }
  return effectiveSignal === "0";
}

export function classifySystemctlArgv(argv: readonly string[]): boolean {
  const endOfOptions = argv.indexOf("--");
  const preSeparatorArgv = endOfOptions === -1 ? argv : argv.slice(0, endOfOptions);
  if (lifecycleHasEffectiveHelpOrVersion(preSeparatorArgv, 1, SYSTEMCTL_OPTIONS_WITH_VALUE)) {
    return false;
  }
  const actionIndex = lifecycleFirstPositional(argv, 1, SYSTEMCTL_OPTIONS_WITH_VALUE);
  const action = normalizedToken(argv[actionIndex]);
  if (!SYSTEMCTL_MUTATIONS.has(action)) {
    const concealedMutation = argv
      .slice(actionIndex + 1)
      .some((token) => SYSTEMCTL_MUTATIONS.has(normalizedToken(token)));
    const optionBeforeAction = argv.slice(1, actionIndex).some((token) => token.startsWith("-"));
    return optionBeforeAction && concealedMutation && argv.some(matchesOpenClawUnitPattern);
  }
  if (action === "kill" && lifecycleArgvUsesSignalZero(argv)) {
    return false;
  }
  return argv.slice(actionIndex + 1).some(matchesOpenClawUnitPattern);
}
