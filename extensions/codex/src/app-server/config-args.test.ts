import { describe, expect, it } from "vitest";
import { resolveCodexAppServerRuntimeOptions } from "./config-runtime.js";

describe("Codex app-server command arguments", () => {
  it.skipIf(process.platform === "win32").each(["config", "env"] as const)(
    "preserves escaped TOML quotes and paths from %s arguments",
    (source) => {
      const raw = String.raw`app-server -c "model=\"gpt-5.6-luna\"" --listen unix:///tmp/codex\ socket #literal`;
      const runtime = resolveCodexAppServerRuntimeOptions({
        pluginConfig: {
          appServer: { mode: "yolo", ...(source === "config" ? { args: raw } : {}) },
        },
        env: source === "env" ? { OPENCLAW_CODEX_APP_SERVER_ARGS: raw } : {},
        requirementsToml: null,
        codexConfigToml: null,
      });
      expect(runtime.start.args).toEqual([
        "app-server",
        "-c",
        'model="gpt-5.6-luna"',
        "--listen",
        "unix:///tmp/codex socket",
        "#literal",
      ]);
    },
  );

  it("rejects unterminated arguments before launching a process", () => {
    expect(() =>
      resolveCodexAppServerRuntimeOptions({
        pluginConfig: { appServer: { mode: "yolo", args: 'app-server --listen "stdio://' } },
        env: {},
        requirementsToml: null,
        codexConfigToml: null,
      }),
    ).toThrow(/unterminated.*appServer\.args/s);
  });
});
