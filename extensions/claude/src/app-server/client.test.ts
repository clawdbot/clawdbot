import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSupportedBridgeVersion,
  ClaudeAppServerVersionError,
  classifyBridgeStderrLevel,
  resolveBridgeSpawnEnv,
  resolveClaudeBridgeSpawnInvocation,
} from "./client.js";
import { assertClaudeBridgeCredentials, resolveClaudeBridgeStartEnv } from "./run-attempt.js";
import { MANAGED_CLAUDE_BRIDGE_PACKAGE, MIN_CLAUDE_BRIDGE_VERSION } from "./version.js";

describe("assertSupportedBridgeVersion", () => {
  it("passes at or above the floor", () => {
    expect(() => assertSupportedBridgeVersion(MIN_CLAUDE_BRIDGE_VERSION, "managed")).not.toThrow();
    expect(() => assertSupportedBridgeVersion("99.0.0", "managed")).not.toThrow();
  });

  it("throws a reinstall-oriented message below the floor for the managed binary", () => {
    let err: unknown;
    try {
      assertSupportedBridgeVersion("0.2.10", "managed");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ClaudeAppServerVersionError);
    const message = (err as Error).message;
    expect(message).toContain("0.2.10");
    expect(message).toContain(MIN_CLAUDE_BRIDGE_VERSION);
    expect(message).toContain(MANAGED_CLAUDE_BRIDGE_PACKAGE);
    expect(message.toLowerCase()).toContain("reinstall");
  });

  it("points an explicit override at appServer.command / the env var", () => {
    for (const source of ["config", "env"] as const) {
      let err: unknown;
      try {
        assertSupportedBridgeVersion("0.2.10", source);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ClaudeAppServerVersionError);
      expect((err as Error).message).toContain("appServer.command");
    }
  });

  it("treats an unknown running version as too old", () => {
    expect(() => assertSupportedBridgeVersion(undefined, "managed")).toThrow(
      ClaudeAppServerVersionError,
    );
  });
});

describe("resolveBridgeSpawnEnv", () => {
  it("forwards safe host env and config overrides to the spawned bridge", () => {
    const env = resolveBridgeSpawnEnv(
      { PATH: "/usr/bin", HOME: "/home/agent", SAFE: "1" },
      { MY_VAR: "ok" },
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/agent");
    expect(env.SAFE).toBe("1");
    expect(env.MY_VAR).toBe("ok");
  });

  it("rejects config-derived overrides that try to inject dangerous exec env (GHSA-VFW7-6RHC-6XXG)", () => {
    // `appServer.env` is workspace-config-derived. A config that sets
    // NODE_OPTIONS / LD_PRELOAD would otherwise be merged straight into the
    // child's env and achieve code execution. The canonical sanitizer rejects
    // those override keys instead of letting them through.
    const env = resolveBridgeSpawnEnv(
      { PATH: "/usr/bin", HOME: "/home/agent" },
      {
        NODE_OPTIONS: "--require /tmp/evil.js",
        LD_PRELOAD: "/tmp/evil.so",
        DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
      },
    );
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined();
  });

  it("never lets a config override replace PATH (command-resolution boundary)", () => {
    const env = resolveBridgeSpawnEnv({ PATH: "/usr/bin" }, { PATH: "/attacker/bin" });
    expect(env.PATH).toBe("/usr/bin");
  });

  it("drops undefined override values before sanitizing", () => {
    const env = resolveBridgeSpawnEnv({ PATH: "/usr/bin" }, { UNSET: undefined, KEEP: "v" });
    expect(env.KEEP).toBe("v");
    expect(Object.hasOwn(env, "UNSET")).toBe(false);
  });
});

describe("resolveClaudeBridgeStartEnv", () => {
  it("passes a resolved Anthropic API key to the bridge as ANTHROPIC_API_KEY", () => {
    expect(resolveClaudeBridgeStartEnv({ resolvedApiKey: " sk-ant-test " })).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-test",
    });
  });

  it("passes a resolved Claude setup-token to the bridge as CLAUDE_CODE_OAUTH_TOKEN", () => {
    expect(
      resolveClaudeBridgeStartEnv({ resolvedApiKey: " sk-ant-oat01-subscription-token " }),
    ).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-subscription-token",
    });
  });

  it("preserves explicit bridge env and does not replace a configured Anthropic key", () => {
    expect(
      resolveClaudeBridgeStartEnv({
        configuredEnv: {
          ANTHROPIC_API_KEY: "configured-key",
          CLAUDE_CONFIG_DIR: "/tmp/claude",
        },
        resolvedApiKey: "resolved-key",
      }),
    ).toEqual({
      ANTHROPIC_API_KEY: "configured-key",
      CLAUDE_CONFIG_DIR: "/tmp/claude",
    });
  });

  it("preserves an explicit OAuth token over a resolved credential", () => {
    expect(
      resolveClaudeBridgeStartEnv({
        configuredEnv: { CLAUDE_CODE_OAUTH_TOKEN: "configured-oauth-token" },
        resolvedApiKey: "sk-ant-test",
      }),
    ).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "configured-oauth-token" });
  });
});

describe("assertClaudeBridgeCredentials (GLM review G5)", () => {
  it("throws an actionable error when a custom base URL has no credentials", () => {
    let err: unknown;
    try {
      assertClaudeBridgeCredentials({
        env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" },
        modelProvider: "zai",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("zai");
    expect(message).toContain("https://api.z.ai/api/anthropic");
    expect(message).toContain("ANTHROPIC_API_KEY");
  });

  it("does NOT throw for stock Anthropic (no custom base URL) with no key — OAuth fallback", () => {
    expect(() => assertClaudeBridgeCredentials({ env: undefined })).not.toThrow();
    expect(() => assertClaudeBridgeCredentials({ env: {} })).not.toThrow();
    expect(() =>
      assertClaudeBridgeCredentials({ env: { CLAUDE_CONFIG_DIR: "/tmp/claude" } }),
    ).not.toThrow();
  });

  it("passes when a custom base URL is paired with any accepted credential", () => {
    const baseUrl = "https://api.z.ai/api/anthropic";
    expect(() =>
      assertClaudeBridgeCredentials({
        env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: "k" },
      }),
    ).not.toThrow();
    expect(() =>
      assertClaudeBridgeCredentials({
        env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: "t" },
      }),
    ).not.toThrow();
    expect(() =>
      assertClaudeBridgeCredentials({ env: { ANTHROPIC_BASE_URL: baseUrl }, resolvedApiKey: "r" }),
    ).not.toThrow();
  });

  it("treats whitespace-only credentials as missing", () => {
    expect(() =>
      assertClaudeBridgeCredentials({
        env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", ANTHROPIC_API_KEY: "  " },
        resolvedApiKey: "  ",
      }),
    ).toThrow();
  });
});

describe("resolveClaudeBridgeSpawnInvocation", () => {
  // Pins the Clawsweeper [P2] finding: on win32 the managed resolver hands
  // start() a node_modules/.bin/openclaw-claude-bridge.cmd shim. Spawning that
  // .cmd raw fails on patched Node, so start() must route it through the shared
  // Windows spawn resolver. These exercise the real resolver with injected
  // platform/env so they run identically on Linux CI.

  it("passes commands through untouched on non-win32", () => {
    const invocation = resolveClaudeBridgeSpawnInvocation(
      { command: "/opt/openclaw/node_modules/.bin/openclaw-claude-bridge", args: ["--stdio"] },
      { platform: "linux", env: { PATH: "/usr/bin" }, execPath: "/usr/bin/node" },
    );
    expect(invocation.command).toBe("/opt/openclaw/node_modules/.bin/openclaw-claude-bridge");
    expect(invocation.args).toEqual(["--stdio"]);
    expect(invocation.shell).toBeUndefined();
    expect(invocation.windowsHide).toBeUndefined();
  });

  it("materializes a win32 .cmd shim down to its real Node entrypoint", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-claude-spawn-"));
    // Real npm-style .cmd shim that delegates to a sibling JS entrypoint.
    const entrypoint = path.join(dir, "bridge-entry.js");
    await writeFile(entrypoint, "// bridge entrypoint\n", "utf8");
    const shim = path.join(dir, "openclaw-claude-bridge.cmd");
    await writeFile(
      shim,
      ["@ECHO off", '"%~dp0\\node.exe"  "%~dp0\\bridge-entry.js" %*'].join("\r\n"),
      "utf8",
    );

    const invocation = resolveClaudeBridgeSpawnInvocation(
      { command: shim, args: ["--stdio"] },
      {
        platform: "win32",
        env: { PATH: dir, PATHEXT: ".CMD;.EXE;.BAT" },
        execPath: "C:\\node\\node.exe",
      },
    );

    // The raw .cmd must NOT reach spawn(); the resolver swaps in node + the
    // resolved JS entrypoint and prepends it before the call-site args.
    expect(invocation.command).toBe("C:\\node\\node.exe");
    expect(invocation.args).toEqual([entrypoint, "--stdio"]);
    expect(invocation.shell).toBeUndefined();
    expect(invocation.windowsHide).toBe(true);
  });

  it("throws rather than spawning a raw .cmd when no entrypoint resolves", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-claude-spawn-"));
    const shim = path.join(dir, "openclaw-claude-bridge.cmd");
    // Opaque wrapper with no discoverable JS/exe entrypoint and no package.json.
    await writeFile(shim, "@ECHO off\r\necho opaque\r\n", "utf8");

    expect(() =>
      resolveClaudeBridgeSpawnInvocation(
        { command: shim, args: [] },
        {
          platform: "win32",
          env: { PATH: dir, PATHEXT: ".CMD;.EXE;.BAT" },
          execPath: "C:\\node\\node.exe",
        },
      ),
    ).toThrow(/without shell execution/);
  });
});

describe("classifyBridgeStderrLevel (openclaw-tb9g)", () => {
  it("promotes the attempt-registry silent-kill WARN out of debug", () => {
    // Verbatim shape the deployed bridge emits from attempt-registry closeEntry()
    // when no turn awaits the discarded attempt — the only signal that a
    // backgrounded command was killed with the subprocess.
    const line =
      '[warn] [attempt-registry] discarded an attempt with no turn awaiting its result — any work still running under this subprocess (e.g. a backgrounded shell command) was silently killed {"threadId":"t1","reason":"dynamic tool catalog changed"}';
    expect(classifyBridgeStderrLevel(line)).toBe("warn");
  });

  it("maps the bridge's own warn/error prefixes onto host levels", () => {
    expect(classifyBridgeStderrLevel("[warn] something degraded")).toBe("warn");
    expect(classifyBridgeStderrLevel("[error] transport died")).toBe("error");
  });

  it("keeps per-RPC info/debug chatter at debug", () => {
    expect(classifyBridgeStderrLevel('[info] [turn/start] received {"threadId":"t1"}')).toBe(
      "debug",
    );
    expect(classifyBridgeStderrLevel("[debug] sdk message")).toBe("debug");
  });

  it("defaults to debug for unprefixed or lookalike lines", () => {
    expect(classifyBridgeStderrLevel("plain stderr from a dependency")).toBe("debug");
    expect(classifyBridgeStderrLevel("")).toBe("debug");
    // Prefix must be at the start and followed by whitespace — no substring match.
    expect(classifyBridgeStderrLevel("emitted [warn] mid-line")).toBe("debug");
    expect(classifyBridgeStderrLevel("[warning] not our formatter")).toBe("debug");
  });

  it("tolerates leading whitespace from wrapped output", () => {
    expect(classifyBridgeStderrLevel("   [error] indented")).toBe("error");
  });
});
