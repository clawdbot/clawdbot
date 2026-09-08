// Preaction parser coverage for explicit legacy migration ownership.
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tryResolveLegacyCompatibilityAgentId } from "../../agents/agent-scope-config.js";
import { createDoctorConfigSnapshot } from "../../commands/doctor-config-snapshot.test-helpers.js";
import type { ConfigFileSnapshot } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  ensureConfigReady:
    vi.fn<
      (options: {
        beforeStateMigrations?: (snapshot?: ConfigFileSnapshot) => Promise<boolean>;
      }) => Promise<void>
    >(),
}));

vi.mock("../../globals.js", () => ({ setVerbose: vi.fn() }));
vi.mock("../../runtime.js", () => ({
  defaultRuntime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
}));
vi.mock("../../logging/console.js", () => ({ routeLogsToStderr: vi.fn() }));
vi.mock("../banner.js", () => ({ emitCliBanner: vi.fn() }));
vi.mock("./config-guard.js", () => ({ ensureConfigReady: mocks.ensureConfigReady }));
vi.mock("../plugin-registry.js", () => ({ ensurePluginRegistryLoaded: vi.fn() }));

const originalArgv = [...process.argv];
const originalTitle = process.title;

function createProgram(): Command {
  const program = new Command().name("openclaw").enablePositionalOptions();
  const models = program.command("models").option("--agent <id>");
  const auth = models.command("auth").option("--agent <id>");
  auth
    .command("setup-token")
    .option("--agent <id>")
    .action(() => {});
  return program;
}

describe("preaction migration agent owner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.title = originalTitle;
  });

  it.each([
    ["leaf", ["models", "auth", "setup-token", "--agent", "main"], "main"],
    ["parent", ["models", "auth", "--agent", "main", "setup-token"], "main"],
    ["grandparent", ["models", "--agent", "main", "auth", "setup-token"], "main"],
    [
      "leaf over parent",
      ["models", "auth", "--agent", "main", "setup-token", "--agent", "work"],
      "work",
    ],
    ["omitted", ["models", "auth", "setup-token"], undefined],
    ["unknown", ["models", "auth", "setup-token", "--agent", "missing"], undefined],
    ["invalid", ["models", "auth", "setup-token", "--agent", "main!"], undefined],
  ])(
    "retains only a valid explicit owner from the %s placement",
    async (_label, argv, expected) => {
      const config = {
        agents: { ownership: "explicit", entries: { main: {}, work: {} } },
      } satisfies OpenClawConfig;
      mocks.ensureConfigReady.mockImplementationOnce(async (options) => {
        await options.beforeStateMigrations?.(createDoctorConfigSnapshot({ config }));
      });
      const program = createProgram();
      const { registerPreActionHooks } = await import("./preaction.js");
      registerPreActionHooks(program, "test");
      process.argv = ["node", "openclaw", ...argv];

      await program.parseAsync(process.argv);

      expect(tryResolveLegacyCompatibilityAgentId(config)).toBe(expected);
    },
  );
});
