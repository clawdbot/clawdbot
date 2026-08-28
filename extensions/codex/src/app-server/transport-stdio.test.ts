// Codex tests cover transport stdio plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerStartOptions } from "./config.js";
import { createStdioTransport, resolveCodexAppServerSpawnEnv } from "./transport-stdio.js";

const spawnMock = vi.hoisted(() => vi.fn(() => ({ pid: 1234 })));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

beforeEach(() => {
  spawnMock.mockClear();
});

function startOptions(command: string): CodexAppServerStartOptions {
  return {
    transport: "stdio",
    command,
    args: ["app-server", "--listen", "stdio://"],
    headers: {},
  };
}

describe("createStdioTransport", () => {
  it("spawns a compatibility endpoint in its configured working directory", () => {
    createStdioTransport({
      ...startOptions("codex"),
      cwd: "/srv/codex-project",
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "codex",
      ["app-server", "--listen", "stdio://"],
      expect.objectContaining({ cwd: "/srv/codex-project" }),
    );
  });

  it("preserves wrapper prefixes, root option values, and raw override ordering", () => {
    const overrides = ["-c", 'developer_instructions="app-server = literal"'];
    const args = [
      "/wrapper.js",
      ...overrides,
      "--profile",
      "app-server",
      "app-server",
      "--listen",
      "stdio://",
      "--config=model_reasoning_effort=high",
    ];
    createStdioTransport({ ...startOptions("node"), args });

    expect(spawnMock).toHaveBeenCalledWith(
      "node",
      [
        "/wrapper.js",
        ...overrides,
        "--profile",
        "app-server",
        "--config=model_reasoning_effort=high",
        "app-server",
        "--listen",
        "stdio://",
      ],
      expect.any(Object),
    );
    expect(args[1]).toBe("-c");
  });

  it("does not reinterpret a wrapper's positional arguments after --", () => {
    const args = ["/wrapper.js", "--", "-c", "opaque", "app-server"];
    createStdioTransport({ ...startOptions("node"), args });
    expect(spawnMock).toHaveBeenCalledWith("node", args, expect.any(Object));
  });

  it.each(["--ws-issuer", "--ws-audience"])("preserves a subcommand-shaped %s value", (flag) => {
    createStdioTransport({
      ...startOptions("codex"),
      args: ["app-server", flag, "app-server", "-c", "model_reasoning_effort=high"],
    });
    expect(spawnMock).toHaveBeenCalledWith(
      "codex",
      ["-c", "model_reasoning_effort=high", "app-server", flag, "app-server"],
      expect.any(Object),
    );
  });
});

describe("resolveCodexAppServerSpawnEnv", () => {
  it("applies configured env overrides before clearing denied env vars", () => {
    expect({
      ...resolveCodexAppServerSpawnEnv(
        {
          env: {
            OPENAI_API_KEY: "configured-openai-key",
            KEEP: "override",
          },
          clearEnv: ["OPENAI_API_KEY", "CODEX_API_KEY", "MISSING"],
        },
        {
          OPENAI_API_KEY: "parent-openai-key",
          CODEX_API_KEY: "parent-codex-key",
          KEEP: "parent",
        },
      ),
    }).toEqual({
      KEEP: "override",
    });
  });

  it("clears denied env vars case-insensitively on Windows", () => {
    expect({
      ...resolveCodexAppServerSpawnEnv(
        {
          env: {
            OpenAI_Api_Key: "configured-openai-key",
            Other: "configured",
          },
          clearEnv: ["OPENAI_API_KEY", " CODEX_API_KEY ", ""],
        },
        {
          Codex_Api_Key: "parent-codex-key",
          KEEP: "parent",
        },
        "win32",
      ),
    }).toEqual({
      KEEP: "parent",
      Other: "configured",
    });
  });

  it("strips inherited runtime loader injection before spawn", () => {
    expect({
      ...resolveCodexAppServerSpawnEnv(
        {
          env: {
            NODE_PATH: "/configured/node_modules",
            DYLD_INSERT_LIBRARIES: "/configured/inject.dylib",
          },
        },
        {
          NODE_PATH: "/ambient/node_modules",
          LD_PRELOAD: "/ambient/inject.so",
          KEEP: "safe",
        },
      ),
    }).toEqual({ KEEP: "safe" });
  });

  it("uses a null-prototype env map and ignores prototype-polluting keys", () => {
    const overrides = Object.create(null) as Record<string, string | undefined>;
    Object.defineProperty(overrides, "__proto__", {
      value: "polluted",
      enumerable: true,
    });
    Object.defineProperty(overrides, "constructor", {
      value: "polluted",
      enumerable: true,
    });
    Object.defineProperty(overrides, "prototype", {
      value: "polluted",
      enumerable: true,
    });
    overrides.SAFE = "1";

    const env = resolveCodexAppServerSpawnEnv(
      {
        env: overrides as Record<string, string>,
      },
      {
        BASE: "1",
      },
    );

    expect(Object.getPrototypeOf(env)).toBeNull();
    expect({ ...env }).toEqual({
      BASE: "1",
      SAFE: "1",
    });
    expect(Object.hasOwn(env, "__proto__")).toBe(false);
    expect(Object.hasOwn(env, "constructor")).toBe(false);
    expect(Object.hasOwn(env, "prototype")).toBe(false);
  });
});
