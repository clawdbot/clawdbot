// Program route tests cover CLI route table registration and dispatch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";
import { tryRouteCli } from "../route.js";

const runConfigGetMock = vi.hoisted(() => vi.fn(async () => {}));
const runConfigUnsetMock = vi.hoisted(() => vi.fn(async () => {}));
const modelsListCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const modelsStatusCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const runDaemonStatusMock = vi.hoisted(() => vi.fn(async () => {}));
const runGatewayHealthJsonRouteMock = vi.hoisted(() => vi.fn(async () => {}));
const statusJsonCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const tasksListJsonCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const tasksAuditJsonCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const channelsListCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const channelsStatusCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const agentsListCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const runPluginsListCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const pluginsCliLoadedMock = vi.hoisted(() => vi.fn());

vi.mock("../command-execution-startup.js", () => ({
  applyCliExecutionStartupPresentation: vi.fn(async () => {}),
  ensureCliExecutionBootstrap: vi.fn(async () => {}),
}));

vi.mock("../config-cli.js", () => ({
  runConfigGet: runConfigGetMock,
  runConfigUnset: runConfigUnsetMock,
}));

vi.mock("../../commands/models/list.list-command.js", () => ({
  modelsListCommand: modelsListCommandMock,
}));
vi.mock("../../commands/models/list.status-command.js", () => ({
  modelsStatusCommand: modelsStatusCommandMock,
}));

vi.mock("../daemon-cli/status.js", () => ({
  runDaemonStatus: runDaemonStatusMock,
}));

vi.mock("../gateway-cli/health-route.js", () => ({
  runGatewayHealthJsonRoute: runGatewayHealthJsonRouteMock,
}));

vi.mock("../../commands/status-json.js", () => ({
  statusJsonCommand: statusJsonCommandMock,
}));

vi.mock("../../commands/tasks-json.js", () => ({
  tasksListJsonCommand: tasksListJsonCommandMock,
  tasksAuditJsonCommand: tasksAuditJsonCommandMock,
}));

vi.mock("../../commands/tasks.js", () => {
  throw new Error("routed task JSON commands must not import the full tasks command module");
});

vi.mock("../../commands/channels/list.js", () => ({
  channelsListCommand: channelsListCommandMock,
}));

vi.mock("../../commands/channels/status.js", () => ({
  channelsStatusCommand: channelsStatusCommandMock,
}));

vi.mock("../../commands/agents.commands.list.js", () => ({
  agentsListCommand: agentsListCommandMock,
}));

vi.mock("../plugins-list-command.js", () => ({
  runPluginsListCommand: runPluginsListCommandMock,
}));

vi.mock("../plugins-cli.js", () => {
  pluginsCliLoadedMock();
  return {
    registerPluginsCli: vi.fn(),
  };
});

function routeArgv(args = ""): string[] {
  return ["node", "openclaw", ...(args ? args.split(" ") : [])];
}

describe("program routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCLAW_LOG_LEVEL", undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  async function expectRunFalse(argv: string[]) {
    await expect(tryRouteCli(argv)).resolves.toBe(false);
  }

  it("passes parsed agents list flags through", async () => {
    await expect(tryRouteCli(routeArgv("agents"))).resolves.toBe(true);
    expect(agentsListCommandMock).toHaveBeenCalledWith(
      { json: false, bindings: false, tree: false },
      defaultRuntime,
    );

    await expect(tryRouteCli(routeArgv("agents list --json --bindings --tree"))).resolves.toBe(
      true,
    );
    expect(agentsListCommandMock).toHaveBeenLastCalledWith(
      { json: true, bindings: true, tree: true },
      defaultRuntime,
    );
  });

  it("passes parsed channel read-only route flags through", async () => {
    await expect(tryRouteCli(routeArgv("channels list --json"))).resolves.toBe(true);
    expect(channelsListCommandMock).toHaveBeenCalledWith(
      { json: true, all: false },
      defaultRuntime,
    );

    await expect(
      tryRouteCli(routeArgv("channels status --json --probe --channel imsg --timeout 5000")),
    ).resolves.toBe(true);
    expect(channelsStatusCommandMock).toHaveBeenCalledWith(
      { channel: "imsg", json: true, probe: true, timeout: "5000" },
      defaultRuntime,
    );
  });

  it.each([
    { label: "default", flags: [], options: { json: false, enabled: false, verbose: false } },
    {
      label: "enabled",
      flags: ["--enabled"],
      options: { json: false, enabled: true, verbose: false },
    },
    {
      label: "verbose",
      flags: ["--verbose"],
      options: { json: false, enabled: false, verbose: true },
    },
    {
      label: "JSON",
      flags: ["--json", "--enabled", "--verbose"],
      options: { json: true, enabled: true, verbose: true },
    },
  ])(
    "routes plugins list $label without importing the full plugins CLI",
    async ({ flags, options }) => {
      await expect(tryRouteCli([...routeArgv("plugins list"), ...flags])).resolves.toBe(true);

      expect(runPluginsListCommandMock).toHaveBeenCalledWith(options, defaultRuntime);
      expect(pluginsCliLoadedMock).not.toHaveBeenCalled();
    },
  );

  it("returns false for plugins list route with unsupported arguments", async () => {
    await expectRunFalse(routeArgv("plugins list --wat"));
  });

  it("routes machine-readable gateway health without plugin preload", async () => {
    await expect(tryRouteCli(routeArgv("gateway health --json --timeout 5000"))).resolves.toBe(
      true,
    );
    expect(runGatewayHealthJsonRouteMock).toHaveBeenCalledWith(
      {
        rpc: {
          url: undefined,
          token: undefined,
          password: undefined,
          timeout: "5000",
          expectFinal: false,
          json: true,
        },
        localPortOverride: undefined,
      },
      defaultRuntime,
    );
  });

  it("falls back for text gateway health output", async () => {
    await expectRunFalse(routeArgv("gateway health"));
  });

  it("returns false for gateway status route when option values are missing", async () => {
    await expectRunFalse(routeArgv("gateway status --url"));
    await expectRunFalse(routeArgv("gateway status --token"));
    await expectRunFalse(routeArgv("gateway status --password"));
    await expectRunFalse(routeArgv("gateway status --timeout"));
  });

  it("returns false for gateway status route when probe-only flags are present", async () => {
    await expectRunFalse(routeArgv("gateway status --ssh user@host"));
    await expectRunFalse(routeArgv("gateway status --ssh-identity ~/.ssh/id_test"));
    await expectRunFalse(routeArgv("gateway status --ssh-auto"));
  });

  it("passes parsed gateway status flags through to daemon status", async () => {
    await expect(
      tryRouteCli(
        routeArgv(
          "--profile work gateway status --url ws://127.0.0.1:18789 --token abc --password def --timeout 5000 --deep --require-rpc --json",
        ),
      ),
    ).resolves.toBe(true);
    expect(runDaemonStatusMock).toHaveBeenCalledWith({
      rpc: {
        url: "ws://127.0.0.1:18789",
        token: "abc",
        password: "def",
        timeout: "5000",
      },
      probe: true,
      requireRpc: true,
      deep: true,
      json: true,
    });
  });

  it("passes --no-probe through to daemon status", async () => {
    await expect(tryRouteCli(routeArgv("gateway status --no-probe"))).resolves.toBe(true);

    expect(runDaemonStatusMock).toHaveBeenCalledWith({
      rpc: {
        url: undefined,
        token: undefined,
        password: undefined,
        timeout: undefined,
      },
      probe: false,
      requireRpc: false,
      deep: false,
      json: false,
    });
  });

  it("returns false when status timeout flag value is missing", async () => {
    await expectRunFalse(routeArgv("status --timeout"));
  });

  it.each([
    { path: ["health"], argv: routeArgv("health --wat") },
    { path: ["status"], argv: routeArgv("status --wat") },
    { path: ["sessions"], argv: routeArgv("sessions --wat") },
    {
      path: ["agents", "list"],
      argv: routeArgv("agents list --wat"),
    },
    { path: ["agents"], argv: routeArgv("agents --wat") },
  ])("returns false instead of handling unknown routed option for $path", async ({ argv }) => {
    await expectRunFalse(argv);
  });

  it("routes status --json through the lean JSON command", async () => {
    await expect(
      tryRouteCli(routeArgv("status --json --deep --usage --agent beta --timeout 5000")),
    ).resolves.toBe(true);
    expect(statusJsonCommandMock).toHaveBeenCalledWith(
      { deep: true, all: false, usage: true, agent: "beta", timeoutMs: 5000 },
      defaultRuntime,
    );
  });

  it("returns false for sessions route when --store value is missing", async () => {
    await expectRunFalse(routeArgv("sessions --store"));
  });

  it.each([
    ["separate empty value", ["node", "openclaw", "sessions", "--store", ""]],
    ["empty assigned value", routeArgv("sessions --store=")],
  ])("falls back to Commander for a sessions --store $0", async (_name, argv) => {
    await expectRunFalse(argv);
  });

  it("returns false for sessions route when --active value is missing", async () => {
    await expectRunFalse(routeArgv("sessions --active"));
  });

  it("returns false for sessions route when --agent value is missing", async () => {
    await expectRunFalse(routeArgv("sessions --agent"));
  });

  it("does not fast-route sessions subcommands", async () => {
    await expectRunFalse(routeArgv("sessions cleanup"));
  });

  it("does not match unknown routes", async () => {
    await expectRunFalse(routeArgv("definitely-not-real"));
  });

  it("returns false for config get route when path argument is missing", async () => {
    await expectRunFalse(routeArgv("config get --json"));
  });

  it("returns false for config unset route when path argument is missing", async () => {
    await expectRunFalse(routeArgv("config unset"));
  });

  it("passes config get path correctly when root option values precede command", async () => {
    await expect(
      tryRouteCli(routeArgv("--log-level debug config get update.channel --json")),
    ).resolves.toBe(true);
    expect(runConfigGetMock).toHaveBeenCalledWith({ path: "update.channel", json: true });
  });

  it("passes config unset path correctly when root option values precede command", async () => {
    await expect(
      tryRouteCli(routeArgv("--profile work config unset update.channel")),
    ).resolves.toBe(true);
    expect(runConfigUnsetMock).toHaveBeenCalledWith({
      path: "update.channel",
      cliOptions: {
        dryRun: false,
        allowExec: false,
        json: false,
      },
    });
  });

  it("passes config get path when root value options appear after subcommand", async () => {
    await expect(
      tryRouteCli(routeArgv("config get --log-level debug update.channel --json")),
    ).resolves.toBe(true);
    expect(runConfigGetMock).toHaveBeenCalledWith({ path: "update.channel", json: true });
  });

  it("passes config unset path when root value options appear after subcommand", async () => {
    await expect(
      tryRouteCli(routeArgv("config unset --profile work update.channel")),
    ).resolves.toBe(true);
    expect(runConfigUnsetMock).toHaveBeenCalledWith({
      path: "update.channel",
      cliOptions: {
        dryRun: false,
        allowExec: false,
        json: false,
      },
    });
  });

  it("passes config unset dry-run options", async () => {
    await expect(
      tryRouteCli(routeArgv("config unset --dry-run --json --allow-exec update.channel")),
    ).resolves.toBe(true);
    expect(runConfigUnsetMock).toHaveBeenCalledWith({
      path: "update.channel",
      cliOptions: {
        dryRun: true,
        allowExec: true,
        json: true,
      },
    });
  });

  it("returns false for config get route when unknown option appears", async () => {
    await expectRunFalse(routeArgv("config get --mystery value update.channel"));
  });

  it("returns false for models list route when --provider value is missing", async () => {
    await expectRunFalse(routeArgv("models list --provider"));
  });

  it("returns false for models status route when probe flags are missing values", async () => {
    await expectRunFalse(routeArgv("models status --probe-provider"));
    await expectRunFalse(routeArgv("models status --probe-timeout"));
    await expectRunFalse(routeArgv("models status --probe-concurrency"));
    await expectRunFalse(routeArgv("models status --probe-max-tokens"));
    await expectRunFalse(routeArgv("models status --probe-provider openai --agent"));
  });

  it("returns false for models status route when --probe-profile has no value", async () => {
    await expectRunFalse(routeArgv("models status --probe-profile"));
  });

  it.each([
    ["bare parent", ["models"], { json: false, plain: false, agent: undefined }],
    ["JSON alias", ["models", "--json"], { json: true, plain: false, agent: undefined }],
    [
      "status JSON alias",
      ["models", "--status-json"],
      { json: true, plain: false, agent: undefined },
    ],
    ["plain alias", ["models", "--status-plain"], { json: false, plain: true, agent: undefined }],
    [
      "agent before alias",
      ["models", "--agent", "main", "--status-json"],
      { json: true, plain: false, agent: "main" },
    ],
    [
      "agent after alias",
      ["models", "--status-json", "--agent=main"],
      { json: true, plain: false, agent: "main" },
    ],
  ] as const)(
    "routes models $name through the canonical status owner",
    async (_name, args, expected) => {
      const argv = ["node", "openclaw", ...args];

      await expect(tryRouteCli(argv)).resolves.toBe(true);
      expect(modelsStatusCommandMock).toHaveBeenCalledWith(expected, defaultRuntime);
    },
  );

  it.each([
    ["child action", ["models", "--status-json", "list"]],
    ["unknown option", ["models", "--unknown"]],
    ["missing agent", ["models", "--agent"]],
    ["argument terminator", ["models", "--", "--status-json"]],
  ])("leaves models parent %s to Commander", async (_name, args) => {
    await expectRunFalse(["node", "openclaw", ...args]);
    expect(modelsStatusCommandMock).not.toHaveBeenCalled();
  });

  it("accepts negative-number probe profile values", async () => {
    await expect(
      tryRouteCli([
        "node",
        "openclaw",
        "models",
        "status",
        "--probe-provider",
        "openai",
        "--probe-timeout",
        "5000",
        "--probe-concurrency",
        "2",
        "--probe-max-tokens",
        "64",
        "--probe-profile",
        "-1",
        "--agent",
        "default",
      ]),
    ).resolves.toBe(true);
    expect(modelsStatusCommandMock).toHaveBeenCalledWith(
      {
        probeProvider: "openai",
        probeTimeout: "5000",
        probeConcurrency: "2",
        probeMaxTokens: "64",
        probeProfile: "-1",
        agent: "default",
        json: false,
        plain: false,
        check: false,
        probe: false,
      },
      defaultRuntime,
    );
  });

  it("routes tasks list JSON through the lean task JSON command", async () => {
    await expect(
      tryRouteCli(["node", "openclaw", "tasks", "--json", "--runtime", "cli", "--status=running"]),
    ).resolves.toBe(true);
    expect(tasksListJsonCommandMock).toHaveBeenCalledWith(
      { json: true, runtime: "cli", status: "running" },
      defaultRuntime,
    );

    await expect(
      tryRouteCli(["node", "openclaw", "tasks", "list", "--json", "--runtime=cron"]),
    ).resolves.toBe(true);
    expect(tasksListJsonCommandMock).toHaveBeenLastCalledWith(
      { json: true, runtime: "cron", status: undefined },
      defaultRuntime,
    );

    await expect(
      tryRouteCli([
        "node",
        "openclaw",
        "tasks",
        "list",
        "--json",
        "--runtime",
        "   ",
        "--status",
        "\t",
      ]),
    ).resolves.toBe(true);
    expect(tasksListJsonCommandMock).toHaveBeenLastCalledWith(
      { json: true, runtime: "   ", status: "\t" },
      defaultRuntime,
    );
  });

  it("routes parent task filter values that command-path discovery sees as positionals", async () => {
    const separateValueArgv = [
      "node",
      "openclaw",
      "tasks",
      "--json",
      "--runtime",
      "cli",
      "--status",
      "running",
    ];
    await expect(tryRouteCli(separateValueArgv)).resolves.toBe(true);
    expect(tasksListJsonCommandMock).toHaveBeenCalledWith(
      { json: true, runtime: "cli", status: "running" },
      defaultRuntime,
    );

    const parentOptionBeforeSubcommandArgv = [
      "node",
      "openclaw",
      "tasks",
      "--runtime",
      "cli",
      "list",
      "--json",
    ];
    await expect(tryRouteCli(parentOptionBeforeSubcommandArgv)).resolves.toBe(true);
    expect(tasksListJsonCommandMock).toHaveBeenLastCalledWith(
      { json: true, runtime: "cli", status: undefined },
      defaultRuntime,
    );
  });

  it("routes tasks audit JSON through the lean task JSON command", async () => {
    await expect(
      tryRouteCli([
        "node",
        "openclaw",
        "tasks",
        "audit",
        "--json",
        "--severity",
        "error",
        "--code=stale_running",
        "--limit",
        "5",
      ]),
    ).resolves.toBe(true);
    expect(tasksAuditJsonCommandMock).toHaveBeenCalledWith(
      { json: true, severity: "error", code: "stale_running", limit: 5 },
      defaultRuntime,
    );

    await expect(
      tryRouteCli([
        "node",
        "openclaw",
        "tasks",
        "audit",
        "--json",
        "--severity",
        "  ",
        "--code",
        "\t",
      ]),
    ).resolves.toBe(true);
    expect(tasksAuditJsonCommandMock).toHaveBeenLastCalledWith(
      { json: true, severity: "  ", code: "\t", limit: undefined },
      defaultRuntime,
    );
  });

  it("returns false for task JSON routes when option values are missing or unknown", async () => {
    await expectRunFalse(["node", "openclaw", "tasks", "--json", "--runtime"]);
    await expectRunFalse(["node", "openclaw", "tasks", "list"]);
    await expectRunFalse(["node", "openclaw", "tasks", "audit", "--json", "--limit"]);
    await expectRunFalse(["node", "openclaw", "tasks", "audit", "--json", "--limit", "5abc"]);
    await expectRunFalse(["node", "openclaw", "tasks", "audit", "--json", "--unknown"]);
    await expectRunFalse(["node", "openclaw", "tasks", "--runtime", "cli"]);
  });
});
