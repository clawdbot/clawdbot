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
  executionMode?: NonNullable<WorkerProvider["supportedExecutionModes"]>[number];
  leaseId: string;
}): { command: string; forwardedEnv?: Record<string, string> } {
  const { enrollment, executionMode, leaseId } = params;
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
          `unset ${CLOUD_SETUP_CODE_ENV}`,
        ]
      : [];
  const launch =
    enrollment.mode === "connect"
      ? `connect --target-file "$setup_code_file" --ephemeral --display-name ${shellQuote(enrollment.displayName)}`
      : `node run --ephemeral --display-name ${shellQuote(enrollment.displayName)}`;
  const prepareCodex = (): string[] => {
    if (executionMode !== "remote-exec") {
      return [];
    }
    // Uncaught node -e errors dump source and append a stack to the diagnosis,
    // pushing the actionable message out of the bounded provider error tail.
    const inspectPlugin = [
      "try{",
      'const fs=require("node:fs"),path=require("node:path"),module=require("node:module");',
      'const inspection=JSON.parse(fs.readFileSync(0,"utf8")),plugin=inspection.plugin;',
      `const version=${JSON.stringify(enrollment.openclawVersion)};`,
      'if(plugin?.id!=="codex"||plugin.packageName!=="@openclaw/codex"||plugin.packageVersion!==version||(plugin.origin!=="bundled"&&(plugin.trustedOfficialInstall!==true||inspection.install?.source!=="npm"))){',
      "throw new Error(`Codex remote-exec requires the exact official @openclaw/codex@${version} plugin to be installed by cloudWorkers profile setup`)}",
      "const root=fs.realpathSync(plugin.rootDir);",
      'const manifest=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));',
      'const requirePlugin=module.createRequire(path.join(root,"package.json"));',
      'const runtime=requirePlugin("@openai/codex/package.json");',
      'if(manifest.name!==plugin.packageName||manifest.version!==version||runtime.version!==manifest.dependencies?.["@openai/codex"]){',
      'throw new Error("Codex remote-exec requires the plugin and its exact pinned native runtime")}',
      'const launcher=requirePlugin.resolve("@openai/codex/bin/codex.js");',
      'const probe=require("node:child_process").spawnSync(process.execPath,[launcher,"--version"],{encoding:"utf8",timeout:10000,stdio:["ignore","pipe","pipe"]});',
      "if(probe.status!==0||probe.stdout?.trim()!==`codex-cli ${runtime.version}`){",
      'throw new Error("Codex remote-exec requires the exact executable platform-native Codex binary")}',
      'if(plugin.origin!=="bundled"){',
      'const project=path.join(process.argv[1],"npm","projects","codex");',
      'const packageRoot=path.join(project,"node_modules","@openclaw");',
      "fs.mkdirSync(packageRoot,{recursive:true,mode:0o700});",
      'const dependency={"@openclaw/codex":version};',
      'fs.writeFileSync(path.join(project,"package.json"),JSON.stringify({name:"openclaw-cloud-codex",private:true,dependencies:dependency})+"\\n",{mode:0o600});',
      'const projected=path.join(packageRoot,"codex");',
      "try{const existing=fs.lstatSync(projected);",
      'if(!existing.isSymbolicLink()||fs.realpathSync(projected)!==root){throw new Error("Codex node plugin path is occupied")}',
      '}catch(error){if(error.code!=="ENOENT"){throw error}fs.symlinkSync(root,projected)}',
      "}",
      "}catch(error){console.error(String(error));process.exitCode=1}",
    ].join("");
    return [
      `"$@" plugins inspect codex --json | node -e ${shellQuote(inspectPlugin)} "$state_dir"`,
      'OPENCLAW_STATE_DIR="$state_dir" "$@" plugins enable codex',
    ];
  };
  const command = [
    "set -eu",
    `state_dir="$HOME/${stateDir}"`,
    'mkdir -p "$state_dir"',
    'chmod 700 "$state_dir"',
    'pid_file="$state_dir/node.pid"',
    'package_spec_file="$state_dir/package-spec"',
    'global_probe_log="$state_dir/global-probe.log"',
    'package_probe_log="$state_dir/package-probe.log"',
    'if [ -s "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then exit 0; fi',
    ...setupCodeLines,
    'if global_version="$(openclaw --version 2>"$global_probe_log")"; then',
    '  case "$global_version" in',
    `    ${versionLabel}|${versionMetadataPrefix}*) printf "%s\\n" "@global" >"$package_spec_file" ;;`,
    "  esac",
    "fi",
    'if [ ! -s "$package_spec_file" ]; then',
    '  rm -f "$package_spec_file"',
    `  for package_candidate in ${packageCandidates}; do`,
    '    if OPENCLAW_STATE_DIR="$state_dir" npx --yes --package "$package_candidate" -- openclaw --version >"$package_probe_log" 2>&1; then',
    '      printf "%s\\n" "$package_candidate" >"$package_spec_file"',
    "      break",
    "    fi",
    "  done",
    "fi",
    'if [ ! -s "$package_spec_file" ]; then',
    `  printf "%s\\n" ${shellQuote(
      `OpenClaw worker bootstrap could not install Gateway version ${enrollment.openclawVersion}; for an unreleased Gateway build, cloudWorkers profile setup must install that exact version globally before enrollment.`,
    )} >&2`,
    '  printf "Last package probe: " >&2',
    '  tail -c 2048 "$package_probe_log" >&2',
    '  printf "\\nGlobal CLI probe: " >&2',
    '  tail -c 1024 "$global_probe_log" >&2',
    // command -v hides inaccessible installs. Inspect PATH as the node user and
    // put the actionable cause last so the provider's redacted error tail keeps it.
    '  printf "%s\\n" "$PATH" | tr ":" "\\n" | while IFS= read -r bin_dir; do',
    '    global_cli="${bin_dir:-.}/openclaw"',
    '    if { [ -e "$global_cli" ] || [ -L "$global_cli" ]; } && { [ ! -r "$global_cli" ] || [ ! -x "$global_cli" ]; }; then',
    '      printf "\\nGlobal openclaw not readable/executable by node user %s: %s\\n" "$(id -un)" "$global_cli" >&2',
    '      ls -ldL "$global_cli" >&2 2>&1 || true',
    '      printf "%s\\n" "Install with umask 022 in the root shell; ensure package files and parent directories are accessible to the node user." >&2',
    "      break",
    "    fi",
    "  done",
    "  exit 1",
    "fi",
    'package_spec="$(cat "$package_spec_file")"',
    'if [ "$package_spec" = "@global" ]; then',
    "  set -- openclaw",
    "else",
    '  set -- npx --yes --package "$package_spec" -- openclaw',
    "fi",
    ...prepareCodex(),
    `setsid -f sh -c 'printf "%s\\n" "$$" >"$1"; shift; exec "$@"' sh "$pid_file" env OPENCLAW_STATE_DIR="$state_dir" "$@" ${launch} >"$state_dir/node.log" 2>&1 </dev/null`,
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
