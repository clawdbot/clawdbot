// Route argument tests cover program route argument parsing and validation.
import { describe, expect, it } from "vitest";
import {
  parseAgentsListRouteArgs,
  parseChannelsListRouteArgs,
  parseChannelsStatusRouteArgs,
  parseConfigGetRouteArgs,
  parseConfigUnsetRouteArgs,
  parseGatewayStatusRouteArgs,
  parseHealthRouteArgs,
  parseModelsListRouteArgs,
  parseModelsStatusRouteArgs,
  parseSessionsRouteArgs,
  parseStatusRouteArgs,
} from "./route-args.js";

describe("route-args", () => {
  it("parses health and status route args", () => {
    expect(
      parseHealthRouteArgs(["node", "openclaw", "health", "--json", "--timeout", "5000"]),
    ).toEqual({
      json: true,
      verbose: false,
      timeoutMs: 5000,
    });
    expect(
      parseStatusRouteArgs([
        "node",
        "openclaw",
        "status",
        "--json",
        "--deep",
        "--all",
        "--usage",
        "--timeout",
        "5000",
      ]),
    ).toEqual({
      json: true,
      deep: true,
      all: true,
      usage: true,
      verbose: false,
      timeoutMs: 5000,
    });
    expect(parseStatusRouteArgs(["node", "openclaw", "status", "--timeout"])).toBeNull();
  });

  it("defers status/health --timeout with a present-but-invalid value to Commander", () => {
    // Regression: the route-first fast path used to silently accept invalid
    // --timeout values (0, negative, non-numeric, unit-suffixed) and run with
    // the default timeout, diverging from the full Commander path which rejects
    // them with a non-zero exit. Returning null defers to Commander so both
    // paths share the same validation.
    for (const bad of ["0", "-5", "nope", "5s"]) {
      expect(parseStatusRouteArgs(["node", "openclaw", "status", "--timeout", bad])).toBeNull();
      expect(parseHealthRouteArgs(["node", "openclaw", "health", "--timeout", bad])).toBeNull();
    }
    expect(
      parseStatusRouteArgs([
        "node",
        "openclaw",
        "status",
        "--timeout",
        "5000",
        "--timeout",
        "nope",
      ]),
    ).toBeNull();
    expect(
      parseHealthRouteArgs([
        "node",
        "openclaw",
        "health",
        "--timeout",
        "nope",
        "--timeout",
        "5000",
      ]),
    ).toMatchObject({ timeoutMs: 5000 });
    // A valid positive integer still parses on the fast path.
    expect(parseStatusRouteArgs(["node", "openclaw", "status", "--timeout", "5000"])).toMatchObject(
      { timeoutMs: 5000 },
    );
    // No --timeout flag at all still uses the fast path (undefined timeout).
    expect(parseStatusRouteArgs(["node", "openclaw", "status"])).toMatchObject({
      timeoutMs: undefined,
    });
  });

  it.each([
    {
      name: "health unknown flag",
      parse: parseHealthRouteArgs,
      argv: ["node", "openclaw", "health", "--wat"],
    },
    {
      name: "health stray positional",
      parse: parseHealthRouteArgs,
      argv: ["node", "openclaw", "health", "extra"],
    },
    {
      name: "health flag terminator",
      parse: parseHealthRouteArgs,
      argv: ["node", "openclaw", "health", "--", "--json"],
    },
    {
      name: "status malformed arity",
      parse: parseStatusRouteArgs,
      argv: ["node", "openclaw", "status", "--timeout"],
    },
    {
      name: "status unknown flag",
      parse: parseStatusRouteArgs,
      argv: ["node", "openclaw", "status", "--wat"],
    },
    {
      name: "sessions stray subcommand",
      parse: parseSessionsRouteArgs,
      argv: ["node", "openclaw", "sessions", "cleanup"],
    },
    {
      name: "sessions unknown flag",
      parse: parseSessionsRouteArgs,
      argv: ["node", "openclaw", "sessions", "--wat"],
    },
    {
      name: "sessions flag terminator",
      parse: parseSessionsRouteArgs,
      argv: ["node", "openclaw", "sessions", "--", "--json"],
    },
    {
      name: "agents list stray positional",
      parse: parseAgentsListRouteArgs,
      argv: ["node", "openclaw", "agents", "list", "extra"],
    },
    {
      name: "agents list unknown flag",
      parse: parseAgentsListRouteArgs,
      argv: ["node", "openclaw", "agents", "list", "--wat"],
    },
    {
      name: "agents list flag terminator",
      parse: parseAgentsListRouteArgs,
      argv: ["node", "openclaw", "agents", "list", "--", "--json"],
    },
    {
      name: "bare agents unknown flag",
      parse: parseAgentsListRouteArgs,
      argv: ["node", "openclaw", "agents", "--wat"],
    },
  ])("defers unsupported routed argv: $name", ({ parse, argv }) => {
    expect(parse(argv)).toBeNull();
  });

  it("preserves equals forms and root options on routed argv", () => {
    expect(
      parseHealthRouteArgs([
        "node",
        "openclaw",
        "--profile",
        "work",
        "health",
        "--timeout=5000",
        "--json",
      ]),
    ).toEqual({ json: true, verbose: false, timeoutMs: 5000 });
    expect(
      parseSessionsRouteArgs(["node", "openclaw", "sessions", "--agent=default", "--limit=25"]),
    ).toMatchObject({ agent: "default", limit: "25" });
    expect(
      parseAgentsListRouteArgs([
        "node",
        "openclaw",
        "--log-level=debug",
        "agents",
        "list",
        "--json",
      ]),
    ).toEqual({ json: true, bindings: false });
    expect(
      parseAgentsListRouteArgs(["node", "openclaw", "agents", "--json", "--bindings"]),
    ).toEqual({ json: true, bindings: true });
  });

  it("parses gateway status route args and rejects probe-only ssh flags", () => {
    expect(
      parseGatewayStatusRouteArgs([
        "node",
        "openclaw",
        "gateway",
        "status",
        "--url",
        "ws://127.0.0.1:18789",
        "--token",
        "abc",
        "--password",
        "def",
        "--timeout",
        "5000",
        "--deep",
        "--require-rpc",
        "--json",
      ]),
    ).toEqual({
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
    expect(
      parseGatewayStatusRouteArgs(["node", "openclaw", "gateway", "status", "--ssh", "host"]),
    ).toBeNull();
    expect(
      parseGatewayStatusRouteArgs(["node", "openclaw", "gateway", "status", "--ssh-auto"]),
    ).toBeNull();
  });

  it("parses sessions and agents list route args", () => {
    expect(
      parseSessionsRouteArgs([
        "node",
        "openclaw",
        "sessions",
        "--json",
        "--all-agents",
        "--agent",
        "default",
        "--store",
        "sqlite",
        "--active",
        "true",
        "--limit",
        "25",
      ]),
    ).toEqual({
      json: true,
      allAgents: true,
      agent: "default",
      store: "sqlite",
      active: "true",
      limit: "25",
    });
    expect(parseSessionsRouteArgs(["node", "openclaw", "sessions", "--agent"])).toBeNull();
    expect(parseSessionsRouteArgs(["node", "openclaw", "sessions", "--limit"])).toBeNull();
    expect(
      parseAgentsListRouteArgs(["node", "openclaw", "agents", "list", "--json", "--bindings"]),
    ).toEqual({
      json: true,
      bindings: true,
    });
    expect(parseAgentsListRouteArgs(["node", "openclaw", "agents"])).toEqual({
      json: false,
      bindings: false,
    });
  });

  it("parses config routes", () => {
    expect(
      parseConfigGetRouteArgs([
        "node",
        "openclaw",
        "--log-level",
        "debug",
        "config",
        "get",
        "update.channel",
        "--json",
      ]),
    ).toEqual({
      path: "update.channel",
      json: true,
    });
    expect(
      parseConfigUnsetRouteArgs([
        "node",
        "openclaw",
        "config",
        "unset",
        "--profile",
        "work",
        "update.channel",
      ]),
    ).toEqual({
      path: "update.channel",
      cliOptions: {
        dryRun: false,
        allowExec: false,
        json: false,
      },
    });
    expect(
      parseConfigUnsetRouteArgs([
        "node",
        "openclaw",
        "config",
        "unset",
        "--dry-run",
        "--json",
        "--allow-exec",
        "update.channel",
      ]),
    ).toEqual({
      path: "update.channel",
      cliOptions: {
        dryRun: true,
        allowExec: true,
        json: true,
      },
    });
    expect(parseConfigGetRouteArgs(["node", "openclaw", "config", "get", "--json"])).toBeNull();
  });

  it("parses models list and models status route args", () => {
    expect(
      parseModelsListRouteArgs([
        "node",
        "openclaw",
        "models",
        "list",
        "--provider",
        "openai",
        "--all",
        "--local",
        "--json",
        "--plain",
      ]),
    ).toEqual({
      provider: "openai",
      all: true,
      local: true,
      json: true,
      plain: true,
    });
    expect(
      parseModelsStatusRouteArgs([
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
        "fast",
        "--probe-profile",
        "safe",
        "--agent",
        "default",
        "--json",
        "--plain",
        "--check",
        "--probe",
      ]),
    ).toEqual({
      probeProvider: "openai",
      probeTimeout: "5000",
      probeConcurrency: "2",
      probeMaxTokens: "64",
      probeProfile: ["fast", "safe"],
      agent: "default",
      json: true,
      plain: true,
      check: true,
      probe: true,
    });
    expect(
      parseModelsStatusRouteArgs(["node", "openclaw", "models", "status", "--probe-profile"]),
    ).toBeNull();
  });

  it.each([
    {
      name: "gateway status",
      parse: parseGatewayStatusRouteArgs,
      argv: ["node", "openclaw", "gateway", "status", "--wat"],
    },
    {
      name: "models list",
      parse: parseModelsListRouteArgs,
      argv: ["node", "openclaw", "models", "list", "--wat"],
    },
    {
      name: "models status",
      parse: parseModelsStatusRouteArgs,
      argv: ["node", "openclaw", "models", "status", "--wat"],
    },
    {
      name: "channels list",
      parse: parseChannelsListRouteArgs,
      argv: ["node", "openclaw", "channels", "list", "--wat"],
    },
    {
      name: "channels status",
      parse: parseChannelsStatusRouteArgs,
      argv: ["node", "openclaw", "channels", "status", "--wat"],
    },
  ])("defers unknown options for sibling routed parser: $name", ({ parse, argv }) => {
    expect(parse(argv)).toBeNull();
  });
});
