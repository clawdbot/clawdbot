// Child fixture: keep registration, finalization, JSON routing, and terminal writers real;
// replace filesystem/plugin work and emit synthetic Doctor and fresh-triage diagnostics.
import fs from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const root = process.env.HOME!;
// Keep real install discovery inside the fixture; no openclaw.mjs means no completion-cache write.
await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
const [scenario, ...args] = process.argv.slice(2);
const sourceUrl = (relative: string) => new URL(relative, import.meta.url).href;
const doctorSource = `
import { intro, note, outro } from ${JSON.stringify(pathToFileURL(require.resolve("@clack/prompts")).href)};
export async function doctorCommand() {
  if (process.argv.includes('--lint')) {
    console.log(JSON.stringify({ ok: true, checksRun: 1, checksSkipped: 0, findings: [] }));
    return;
  }
  if (process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION !== '0') {
    throw new Error('Update Doctor unexpectedly allowed gateway activation');
  }
  intro('OpenClaw doctor');
  note('Doctor panel diagnostic', 'Repair');
  if (!process.argv.includes('--no-workspace-suggestions')) note('Doctor workspace diagnostic', 'Workspace');
  console.log('Doctor console diagnostic');
  process.stderr.write('Doctor stderr diagnostic\\n');
  outro('Doctor complete.');
  ${scenario === "doctor-error" ? "throw new Error('Doctor repair failed');" : ""}
}
`;
const installedEntry = path.join(root, "installed-cli.mjs");
await fs.writeFile(
  installedEntry,
  `
import fs from 'node:fs/promises';
import path from 'node:path';
${doctorSource}
async function triageCommand() {
  const contextIndex = process.argv.indexOf('--update-result');
  if (contextIndex < 0) throw new Error('Missing update failure artifact');
  await fs.readFile(process.argv[contextIndex + 1], 'utf8');
  const promptPath = path.join(process.env.OPENCLAW_STATE_DIR, 'logs', 'support', 'triage-fixture-prompt.md');
  await fs.mkdir(path.dirname(promptPath), { recursive: true });
  await fs.writeFile(promptPath, 'Synthetic update failure debugging prompt.\\n');
  const suggestedCommands = ['openclaw triage --run'];
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ promptPath, bundlePath: null, bundleError: null, findings: { error: 0, warning: 0, info: 0 }, detectedAgents: [], suggestedCommands }));
  } else {
    console.log('Debugging prompt: ' + promptPath);
    console.log('Ready-to-run agent handoffs:');
    for (const command of suggestedCommands) console.log('  ' + command);
  }
}
try {
  if (process.argv[2] === 'doctor') await doctorCommand();
  else if (process.argv.slice(2).join(' ') === 'config validate --json') {
    if (process.env.OPENCLAW_UPDATE_IN_PROGRESS !== '0') {
      throw new Error('Config validation must use strict mode');
    }
    console.log(JSON.stringify({ valid: true, path: process.env.OPENCLAW_CONFIG_PATH, warnings: [] }));
  }
  else if (process.argv[2] === 'triage') await triageCommand();
  else throw new Error('Unexpected installed CLI command: ' + process.argv[2]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
`,
);
const snapshotSource = `
const config = { update: { channel: 'dev' }, plugins: { enabled: false } };
export const readConfigFileSnapshot = async () => ({ valid: true, config, sourceConfig: config, parsed: config });
export const assertConfigWriteAllowedInCurrentMode = () => {};
`;
const stubs = new Map<string, string>([
  [sourceUrl("../commands/doctor.ts"), doctorSource],
  [sourceUrl("../config/config.ts"), snapshotSource],
  [
    sourceUrl("../plugins/installed-plugin-index-records.ts"),
    "export const loadInstalledPluginIndexInstallRecords = async () => ({});",
  ],
  [
    sourceUrl("../plugins/plugin-lifecycle-lease.ts"),
    "export const withPluginLifecycleLease = async (_options, run) => await run();",
  ],
  [
    sourceUrl("./update-cli/update-command-config-snapshot.ts"),
    "export const createUpdateConfigSnapshot = async () => {};",
  ],
  [
    sourceUrl("./update-cli/update-command-config.ts"),
    "export const readPostCorePreUpdateSourceConfig = async () => undefined; export const persistRequestedUpdateChannel = async ({configSnapshot}) => configSnapshot; export const persistValidatedDowngradeConfig = async () => {}; export const restoreDroppedPreUpdateChannels = snapshot => ({snapshot, changed: false});",
  ],
  [
    sourceUrl("./update-cli/update-command-plugins.ts"),
    `export const updatePluginsAfterCoreUpdate = async () => ({status: ${JSON.stringify(scenario?.endsWith("plugin-error") ? "error" : scenario?.endsWith("plugin-warning") ? "warning" : "ok")}, changed: false, warnings: [], sync: {changed: false, switchedToBundled: [], switchedToNpm: [], warnings: [], errors: []}, npm: {changed: false, outcomes: []}, integrityDrifts: []});`,
  ],
  [
    sourceUrl("../daemon/gateway-entrypoint.ts"),
    `export const resolveGatewayInstallEntrypoint = async () => ${JSON.stringify(installedEntry)};`,
  ],
]);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") || specifier.startsWith("file:")) {
      const url = new URL(specifier, context.parentURL).href.replace(/\.js$/, ".ts");
      const source = stubs.get(url);
      if (source !== undefined) {
        return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const { Command } = await import("commander");
const { registerUpdateCli } = await import("./update-cli.js");
const { defaultRuntime } = await import("../runtime.js");
const { formatCliJsonFailure } = await import("./failure-output.js");
const { runCliWithExitFinalization } = await import("./one-shot-exit.js");
const { enableConsoleCapture } = await import("../logging/console.js");
const { withConsoleLogsRoutedToStderrForJson, applyResolvedCommandOutputMode } =
  await import("./json-output-mode.js");
const { isCommandJsonOutputMode } = await import("./program/json-mode.js");
process.argv = [process.execPath, path.join(root, "openclaw.mjs"), ...args];
enableConsoleCapture();
await runCliWithExitFinalization({
  run: () =>
    withConsoleLogsRoutedToStderrForJson(
      process.argv,
      async () => {
        const program = new Command().name("openclaw");
        program.hook("preAction", (_root, command) => {
          applyResolvedCommandOutputMode(isCommandJsonOutputMode(command));
        });
        registerUpdateCli(program);
        await program.parseAsync(process.argv);
      },
      { retainRoutingUntilProcessExit: true },
    ),
  onError: (error) => {
    defaultRuntime.writeJson(formatCliJsonFailure(error));
    process.exitCode = 1;
  },
});
