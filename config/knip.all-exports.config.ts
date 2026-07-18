/**
 * Full-repository unused-export audit.
 *
 * Production Knip intentionally ignores test-support exports. This companion
 * config makes every test/spec file an entry and audits those support modules
 * too, so a helper used by a src/ or plugin test cannot be mistaken for dead
 * code while genuinely unused test and script exports still fail the gate.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import productionConfig from "./knip.config.ts";

const TEST_ENTRY_GLOB = "**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}!";

function listQaScenarioExecutionEntries(dir = "qa/scenarios"): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return listQaScenarioExecutionEntries(entryPath);
    }
    if (!entry.isFile() || (!entry.name.endsWith(".yaml") && !entry.name.endsWith(".yml"))) {
      return [];
    }
    const document = YAML.parse(fs.readFileSync(entryPath, "utf8")) as {
      scenario?: { execution?: { kind?: unknown; path?: unknown } };
    };
    const execution = document.scenario?.execution;
    return execution?.kind !== "flow" && typeof execution?.path === "string"
      ? [`${execution.path}!`]
      : [];
  });
  return [...new Set(entries)].toSorted((left, right) => left.localeCompare(right));
}

const QA_SCENARIO_EXECUTION_ENTRIES = listQaScenarioExecutionEntries();
const ROOT_TEST_ENTRY_GLOBS = [
  "*.{test,spec}.{js,mjs,cjs,ts,mts,cts}!",
  "src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}!",
  "scripts/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}!",
  "test/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}!",
  // Vitest loads these by configuration or module alias rather than imports.
  "test/setup*.ts!",
  "test/non-isolated-runner.ts!",
  "test/vitest/*-runtime.ts!",
  "test/vitest/vitest*.config.ts!",
  // Test drivers and Docker fixtures are executed by path from package scripts
  // and the test-project registry.
  "test/e2e/qa-lab/runtime/agent-bundle-mcp-tools-docker-client.ts!",
  "test/e2e/qa-lab/runtime/docker-e2e-lane.ts!",
  "test/e2e/qa-lab/runtime/mcp-channels-docker-client.ts!",
  // Invoked directly by the Docker image-auth scenario.
  "test/e2e/qa-lab/runtime/openai-image-auth-docker-client.ts!",
  "test/e2e/qa-lab/runtime/system-agent-first-run-docker-client.ts!",
  // QA scenario YAML dispatches these scripts/tests by path rather than import.
  ...QA_SCENARIO_EXECUTION_ENTRIES,
  // The Voice Call QA scenario loads this fixture through a generated plugin directory.
  "test/e2e/qa-lab/runtime/fixtures/voice-call-runtime-plugin/index.js!",
  "test/scripts/fixtures/secret-provider-integrations-harness.mjs!",
  // Loaded with cache-busting query strings so configuration fallback tests
  // get independent module initialization.
  "test/helpers/config/bundled-channel-config-runtime.ts!",
  // The topology analyzer owns these as an intentionally self-contained graph.
  "test/fixtures/ts-topology/basic/**/*.{js,mjs,cjs,ts,mts,cts}!",
  // The focused Oxlint test invokes these deliberate violations by path.
  "test/fixtures/oxlint-boundary-guards/*.ts!",
] as const;

const workspaces = Object.fromEntries(
  Object.entries(productionConfig.workspaces).map(([workspace, settings]) => [
    workspace,
    {
      ...settings,
      ...(workspace === "."
        ? {
            // Root test aliases and mocks load these from their owning bundled
            // plugin workspaces; do not duplicate plugin runtime dependencies.
            ignoreDependencies: [
              ...("ignoreDependencies" in settings ? settings.ignoreDependencies : []),
              "baileys",
              "discord-api-types",
            ],
          }
        : {}),
      entry: [
        ...settings.entry,
        ...(workspace === "."
          ? [".agents/skills/**/scripts/**/*.{js,mjs,cjs,ts,mts,cts}!", ...ROOT_TEST_ENTRY_GLOBS]
          : [TEST_ENTRY_GLOB]),
      ],
      project:
        workspace === "."
          ? [...settings.project, ".agents/skills/**/scripts/**/*.{js,mjs,cjs,ts,mts,cts}!"]
          : settings.project,
    },
  ]),
);

const config = {
  ...productionConfig,
  ignoreFiles: [
    // The production pass omits scripts, live probes, and generated runtime
    // surfaces. This test-aware pass audits all source files; only build output
    // and ambient declarations stay excluded.
    "dist/**",
    "packages/*/dist/**",
    "scripts/**/*.d.{mts,ts}",
    // Ambient declarations and handwritten declaration companions are type
    // inputs, not executable roots.
    "test/external-script-modules.d.ts",
    "test/vitest/**/*.d.{mts,ts}",
  ],
  // Keep only build artifacts out of the full-tree export audit. In
  // particular, do not inherit production's test-support exclusions.
  ignore: ["dist/**", "packages/*/dist/**", "**/.boundary-stubs/**"],
  // This fixture deliberately mixes used, aliased, and unused exports so the
  // topology analyzer can prove each classification.
  ignoreIssues: {
    // Cache-busting dynamic imports are real consumers, but Knip cannot map
    // their query-suffixed module ids back to these named test-support exports.
    "test/helpers/config/bundled-channel-config-runtime.ts": ["exports"],
    "test/fixtures/ts-topology/basic/**": [
      "exports",
      "nsExports",
      "types",
      "nsTypes",
      "enumMembers",
      "namespaceMembers",
    ],
  },
  workspaces,
};

export default config;
