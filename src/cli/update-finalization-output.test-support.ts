// Child fixture: keep registration, finalization, JSON routing, and terminal writers real;
// replace filesystem/plugin work and emit deterministic doctor diagnostics.
import fs from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const root = process.env.HOME!;
// Keep real install discovery inside the fixture; no entrypoint means no completion write.
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
  intro('OpenClaw doctor');
  note('Doctor panel diagnostic', 'Repair');
  if (!process.argv.includes('--no-workspace-suggestions')) note('Doctor workspace diagnostic', 'Workspace');
  console.log('Doctor console diagnostic');
  process.stderr.write('Doctor stderr diagnostic\\n');
  outro('Doctor complete.');
  ${scenario === "doctor-error" ? "throw new Error('Doctor repair failed');" : ""}
}
`;
const doctorEntry = path.join(root, "doctor.mjs");
await fs.writeFile(
  doctorEntry,
  `${doctorSource}\ntry { await doctorCommand(); } catch (error) { console.error(error.message); process.exitCode = 1; }\n`,
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
    sourceUrl("./update-cli/update-command-config.ts"),
    "export const createUpdateConfigSnapshot = async () => {}; export const readPostCorePreUpdateSourceConfig = async () => undefined; export const persistRequestedUpdateChannel = async ({configSnapshot}) => configSnapshot; export const persistValidatedDowngradeConfig = async () => {}; export const restoreDroppedPreUpdateChannels = snapshot => ({snapshot, changed: false});",
  ],
  [
    sourceUrl("./update-cli/update-command-plugins.ts"),
    `export const updatePluginsAfterCoreUpdate = async () => ({status: ${JSON.stringify(scenario === "plugin-error" ? "error" : "ok")}, changed: false, warnings: [], sync: {changed: false, switchedToBundled: [], switchedToNpm: [], warnings: [], errors: []}, npm: {changed: false, outcomes: []}, integrityDrifts: []});`,
  ],
  [
    sourceUrl("../daemon/gateway-entrypoint.ts"),
    `export const resolveGatewayInstallEntrypoint = async () => ${JSON.stringify(doctorEntry)};`,
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
const { enableConsoleCapture } = await import("../logging/console.js");
const { withConsoleLogsRoutedToStderrForJson, applyResolvedCommandOutputMode } =
  await import("./json-output-mode.js");
const { isCommandJsonOutputMode } = await import("./program/json-mode.js");
process.argv = [process.execPath, path.join(root, "openclaw.mjs"), ...args];
enableConsoleCapture();
await withConsoleLogsRoutedToStderrForJson(process.argv, async () => {
  const program = new Command().name("openclaw");
  program.hook("preAction", (_root, command) => {
    applyResolvedCommandOutputMode(isCommandJsonOutputMode(command));
  });
  registerUpdateCli(program);
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    defaultRuntime.writeJson(formatCliJsonFailure(error));
    process.exitCode = 1;
  }
});
