import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";

const CLOUD_SETUP_CODE_ENV = "CRABBOX_WORKER_SETUP_CODE";

export type CrabboxWorkerNodeEnrollment = Awaited<
  ReturnType<
    NonNullable<NonNullable<Parameters<WorkerProvider["provision"]>[2]>["beginNodeEnrollment"]>
  >
>;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function createCrabboxNodeEnrollmentSetup(params: {
  enrollment: CrabboxWorkerNodeEnrollment;
  leaseId: string;
}): { command: string; forwardedEnv?: Record<string, string> } {
  const { enrollment, leaseId } = params;
  const stateDir = `.openclaw/cloud-workers/${leaseId}`;
  const packageCandidates = enrollment.packageSpecs.map(shellQuote).join(" ");
  if (!packageCandidates) {
    throw new Error("Worker node enrollment has no OpenClaw package source");
  }
  const versionLabel = shellQuote(`OpenClaw ${enrollment.openclawVersion}`);
  const versionMetadataPrefix = shellQuote(`OpenClaw ${enrollment.openclawVersion} `);
  const setupCodeLines =
    enrollment.mode === "connect"
      ? [
          'setup_code_file="$state_dir/setup-code"',
          "umask 077",
          `printf "%s\\n" "$${CLOUD_SETUP_CODE_ENV}" >"$setup_code_file"`,
        ]
      : [];
  const launch =
    enrollment.mode === "connect"
      ? `connect --target-file "$setup_code_file" --ephemeral --display-name ${shellQuote(enrollment.displayName)}`
      : `node run --ephemeral --display-name ${shellQuote(enrollment.displayName)}`;
  const command = [
    "set -eu",
    `state_dir="$HOME/${stateDir}"`,
    'mkdir -p "$state_dir"',
    'chmod 700 "$state_dir"',
    'pid_file="$state_dir/node.pid"',
    'package_spec_file="$state_dir/package-spec"',
    'if [ -s "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then exit 0; fi',
    ...setupCodeLines,
    "if command -v openclaw >/dev/null 2>&1; then",
    '  case "$(openclaw --version 2>/dev/null || true)" in',
    `    ${versionLabel}|${versionMetadataPrefix}*) printf "%s\\n" "@global" >"$package_spec_file" ;;`,
    "  esac",
    "fi",
    'if [ ! -s "$package_spec_file" ]; then',
    '  rm -f "$package_spec_file"',
    `  for package_candidate in ${packageCandidates}; do`,
    '    if OPENCLAW_STATE_DIR="$state_dir" npx --yes --package "$package_candidate" -- openclaw --version >/dev/null 2>&1; then',
    '      printf "%s\\n" "$package_candidate" >"$package_spec_file"',
    "      break",
    "    fi",
    "  done",
    "fi",
    'if [ ! -s "$package_spec_file" ]; then',
    `  printf "%s\\n" ${shellQuote(
      `OpenClaw worker bootstrap could not install Gateway version ${enrollment.openclawVersion}; for an unreleased Gateway build, cloudWorkers profile setup must install that exact version globally before enrollment.`,
    )} >&2`,
    "  exit 1",
    "fi",
    'package_spec="$(cat "$package_spec_file")"',
    'if [ "$package_spec" = "@global" ]; then',
    `  setsid -f sh -c 'printf "%s\\n" "$$" >"$1"; shift; exec "$@"' sh "$pid_file" env OPENCLAW_STATE_DIR="$state_dir" openclaw ${launch} >"$state_dir/node.log" 2>&1 </dev/null`,
    "else",
    `  setsid -f sh -c 'printf "%s\\n" "$$" >"$1"; shift; exec "$@"' sh "$pid_file" env OPENCLAW_STATE_DIR="$state_dir" npx --yes --package "$package_spec" -- openclaw ${launch} >"$state_dir/node.log" 2>&1 </dev/null`,
    "fi",
    'for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$pid_file" ] && break; sleep 0.1; done',
    'test -s "$pid_file"',
  ].join("\n");
  return {
    command,
    ...(enrollment.mode === "connect"
      ? { forwardedEnv: { [CLOUD_SETUP_CODE_ENV]: enrollment.setupCode } }
      : {}),
  };
}
