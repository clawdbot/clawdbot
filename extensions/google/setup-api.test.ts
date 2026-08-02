import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { describe, expect, it } from "vitest";
import { buildGoogleGeminiCliBackend } from "./cli-backend.js";
import setupEntry from "./setup-api.js";

describe("google setup entry", () => {
  it("registers setup runtime providers declared by the manifest", () => {
    const providerIds: string[] = [];
    const cliBackendIds: string[] = [];

    setupEntry.register({
      registerProvider(provider: ProviderPlugin) {
        providerIds.push(provider.id);
      },
      registerCliBackend(backend: CliBackendPlugin) {
        cliBackendIds.push(backend.id);
      },
    } as never);

    expect(providerIds).toEqual(["google-vertex"]);
    expect(cliBackendIds).toEqual(["google-gemini-cli"]);
  });
});

describe("google gemini cli backend config", () => {
  it.each([
    {
      phase: "fresh",
      key: "args" as const,
      expected: [
        "--skip-trust",
        "--approval-mode",
        "auto_edit",
        "--output-format",
        "stream-json",
        "--prompt",
        "{prompt}",
      ],
    },
    {
      phase: "resume",
      key: "resumeArgs" as const,
      expected: [
        "--skip-trust",
        "--approval-mode",
        "auto_edit",
        "--resume",
        "{sessionId}",
        "--output-format",
        "stream-json",
        "--prompt",
        "{prompt}",
      ],
    },
  ])("preserves the legacy $phase command bytes in plugin code", ({ key, expected }) => {
    const backend = buildGoogleGeminiCliBackend();

    expect(backend.config.command).toBe("gemini");
    expect(backend.config[key]).toEqual(expected);
    expect(backend.config.env).toBeUndefined();
    expect(backend.config.clearEnv).toBeUndefined();
  });

  it("declares its bundled package implementation boundary", () => {
    const backend = buildGoogleGeminiCliBackend();
    expect(backend.runtimeArtifact).toEqual({
      kind: "bundled-package-tree",
      packageName: "@google/gemini-cli",
      entrypoint: "command",
      exactToolAvailabilityVersionPolicy: {
        stableMinimum: "0.39.1",
        prereleaseMinimums: {
          preview: "0.40.0-preview.3",
          nightly: "0.41.0-nightly.20260427.g42587de73",
        },
      },
    });
    expect(backend.nativeToolMode).toBe("selectable");
    expect(backend.toolAvailabilityEnforcement).toBe("prepare-execution");
  });

  it("enforces exact MCP server availability with a per-run argv override", () => {
    const backend = buildGoogleGeminiCliBackend();
    const baseContext = {
      workspaceDir: "/tmp/openclaw-gemini-test",
      provider: "google-gemini-cli",
      modelId: "gemini-3.1-pro-preview",
      useResume: false,
      baseArgs: [
        "--allowedMcpServerNames",
        "camel-hostile",
        "--allowed_mcp_server_names=snake-hostile",
        "--allowed-mcp-server-names",
        "hostile",
        "--allowed-mcp-server-names=also-hostile",
        "--prompt",
        "{prompt}",
        "--",
        "--allowed-mcp-server-names",
        "positional-hostile",
      ],
    };

    const restrictedArgs = backend.resolveExecutionArgs?.({
      ...baseContext,
      toolAvailability: { native: [], openClaw: ["read"], mcp: ["read"] },
    });
    expect(restrictedArgs).toEqual([
      "--prompt",
      "{prompt}",
      "--allowed-mcp-server-names",
      "openclaw",
      "--",
      "--allowed-mcp-server-names",
      "positional-hostile",
    ]);

    const emptyArgs = backend.resolveExecutionArgs?.({
      ...baseContext,
      toolAvailability: { native: [], openClaw: [], mcp: [] },
    });
    expect(emptyArgs?.slice(0, -4)).toEqual(["--prompt", "{prompt}", "--allowed-mcp-server-names"]);
    expect(emptyArgs?.at(-4)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(emptyArgs?.slice(-3)).toEqual([
      "--",
      "--allowed-mcp-server-names",
      "positional-hostile",
    ]);
  });

  it("keeps legacy json output overrides on the json parser", () => {
    const backend = buildGoogleGeminiCliBackend();
    const normalized = backend.normalizeConfig?.({
      ...backend.config,
      args: ["--skip-trust", "--output-format", "json", "--prompt", "{prompt}"],
      resumeArgs: [
        "--skip-trust",
        "--resume",
        "{sessionId}",
        "--output-format=json",
        "--prompt",
        "{prompt}",
      ],
    });

    expect(normalized?.output).toBe("json");
    expect(normalized?.resumeOutput).toBe("json");
    expect(normalized?.jsonlDialect).toBeUndefined();
  });

  it("keeps short stream-json output overrides on the jsonl parser", () => {
    const backend = buildGoogleGeminiCliBackend();
    const normalized = backend.normalizeConfig?.({
      ...backend.config,
      args: ["--skip-trust", "-o", "stream-json", "--prompt", "{prompt}"],
      resumeArgs: [
        "--skip-trust",
        "--resume",
        "{sessionId}",
        "-o=stream-json",
        "--prompt",
        "{prompt}",
      ],
    });

    expect(normalized?.output).toBe("jsonl");
    expect(normalized?.resumeOutput).toBe("jsonl");
    expect(normalized?.jsonlDialect).toBe("gemini-stream-json");
  });
});
