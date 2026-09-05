import { describe, expect, it } from "vitest";
import { resolveCodexAppServerRuntimeOptions } from "./config-runtime.js";

describe.each(["config", "env"] as const)("Codex app-server %s arguments", (source) => {
  it.each([
    {
      raw: String.raw`app-server -c log_dir=/tmp/openclaw\logs --listen stdio://`,
      expected: [
        "app-server",
        "-c",
        String.raw`log_dir=/tmp/openclaw\logs`,
        "--listen",
        "stdio://",
      ],
    },
    {
      raw: 'app-server --listen "stdio://',
      expected: ["app-server", "--listen", "stdio://"],
    },
  ])("preserves shipped string parsing: $raw", ({ raw, expected }) => {
    const runtime = resolveCodexAppServerRuntimeOptions({
      pluginConfig: {
        appServer: { mode: "yolo", ...(source === "config" ? { args: raw } : {}) },
      },
      env: source === "env" ? { OPENCLAW_CODEX_APP_SERVER_ARGS: raw } : {},
      requirementsToml: null,
      codexConfigToml: null,
    });
    expect(runtime.start.args).toEqual(expected);
  });
});

it("preserves literal array values and existing whitespace normalization", () => {
  const runtime = resolveCodexAppServerRuntimeOptions({
    pluginConfig: {
      appServer: {
        mode: "yolo",
        args: [
          " app-server ",
          "-c",
          'model="gpt-5.6-luna"',
          "-c",
          String.raw`log_dir=/tmp/openclaw\logs`,
          "",
        ],
      },
    },
    env: { OPENCLAW_CODEX_APP_SERVER_ARGS: "ignored" },
    requirementsToml: null,
    codexConfigToml: null,
  });
  expect(runtime.start.args).toEqual([
    "app-server",
    "-c",
    'model="gpt-5.6-luna"',
    "-c",
    String.raw`log_dir=/tmp/openclaw\logs`,
  ]);
});
