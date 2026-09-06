import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { resolvePreparedExecEnvironment } from "./bash-tools.exec-request-preparation.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { prepareGitHubToolEnvironment } from "./github-tool-identity.js";

const storeMocks = vi.hoisted(() => ({ readSecretStoreExecEnvironment: vi.fn() }));

vi.mock("../secrets/store/secret-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../secrets/store/secret-store.js")>()),
  readSecretStoreExecEnvironment: storeMocks.readSecretStoreExecEnvironment,
}));

const snapshot = captureEnv(["GH_TOKEN", "GITHUB_TOKEN", "PREVIEW_SERVICE_TOKEN"]);

afterEach(() => {
  snapshot.restore();
  storeMocks.readSecretStoreExecEnvironment.mockReset();
});

function prepare(
  host: "gateway" | "sandbox",
  prepared?: {
    credentialScrubEnv: Readonly<Record<string, string>>;
    localIdentityEnv: Readonly<Record<string, string>>;
    managedLocalIdentity?: boolean;
  },
  includeStoreSecrets = true,
) {
  return resolvePreparedExecEnvironment({
    execParams: { command: "gh api user" },
    host,
    ...(host === "sandbox"
      ? {
          sandbox: {
            containerName: "sandbox",
            workspaceDir: "/workspace",
            containerWorkdir: "/workspace",
          },
        }
      : {}),
    defaultPathPrepend: [],
    storeSecretEnv: includeStoreSecrets
      ? { GH_TOKEN: "store-sentinel", GITHUB_TOKEN: "store-sentinel" }
      : undefined,
    credentialScrubEnv: prepared?.credentialScrubEnv,
    localIdentityEnv: prepared?.localIdentityEnv,
    managedLocalIdentity: prepared?.managedLocalIdentity,
    warnings: [],
  });
}

describe("exec GitHub identity", () => {
  it("blanks ambient service tokens and applies managed identity only to local gateway exec", () => {
    setTestEnvValue("GH_TOKEN", "ambient-token");
    setTestEnvValue("GITHUB_TOKEN", "ambient-fallback");
    const prepared = {
      credentialScrubEnv: { GH_TOKEN: "", GITHUB_TOKEN: "" },
      localIdentityEnv: { GH_CONFIG_DIR: "/private/managed-gh", GIT_AUTHOR_NAME: "Managed" },
      managedLocalIdentity: true,
    };
    for (const host of ["gateway", "sandbox"] as const) {
      const result = prepare(host, prepared);
      expect(result.env.GH_TOKEN).toBe("");
      expect(result.env.GITHUB_TOKEN).toBe("");
      expect(result.requestedEnv?.GH_TOKEN).toBe("");
      expect(result.requestedEnv?.GITHUB_TOKEN).toBe("");
      if (host === "gateway") {
        expect(result.env.GH_CONFIG_DIR).toBe("/private/managed-gh");
        expect(result.env.GIT_AUTHOR_NAME).toBe("Managed");
      } else {
        expect(result.env).not.toHaveProperty("GH_CONFIG_DIR");
        expect(result.env).not.toHaveProperty("GIT_AUTHOR_NAME");
        expect(result.requestedEnv).not.toHaveProperty("GH_CONFIG_DIR");
        expect(result.requestedEnv).not.toHaveProperty("GIT_AUTHOR_NAME");
      }
    }
  });

  it("keeps required sandbox execution isolated from host overrides, elevation, and GitHub credentials", async () => {
    setTestEnvValue("GH_TOKEN", "ambient-token");
    setTestEnvValue("GITHUB_TOKEN", "ambient-fallback");
    storeMocks.readSecretStoreExecEnvironment.mockReturnValue({ env: {} });
    const buildExecSpec = vi.fn(async ({ env }: { env: Record<string, string> }) => ({
      argv: [process.execPath, "-e", "process.stdout.write('sandbox-ok')"],
      env,
      stdinMode: "pipe-closed" as const,
    }));
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      allowBackground: false,
      sandboxRequired: true,
      sandbox: {
        containerName: "required-sandbox",
        workspaceDir: process.cwd(),
        containerWorkdir: "/workspace",
        buildExecSpec,
      },
      elevated: { enabled: true, allowed: true, defaultLevel: "full" },
      preparedRunEnvironment: prepareGitHubToolEnvironment({
        config: { tools: { github: { profileId: "ghp_99999999999999999999999999999999" } } },
        agentId: "main",
      }),
    });

    for (const host of ["gateway", "node"] as const) {
      await expect(
        tool.execute(`required-denied-${host}`, { command: "echo denied", host }),
      ).rejects.toThrow(/not allowed/i);
    }
    await expect(
      tool.execute("required-denied-elevation", { command: "echo denied", elevated: true }),
    ).rejects.toThrow(/requires a sandbox/i);

    const result = await tool.execute("required-sandbox", { command: "echo sandbox-ok" });

    expect(result.details.status).toBe("completed");
    expect(buildExecSpec).toHaveBeenCalledOnce();
    const sandboxEnv = buildExecSpec.mock.calls[0]![0].env;
    expect(sandboxEnv.GH_TOKEN).toBe("");
    expect(sandboxEnv.GITHUB_TOKEN).toBe("");
    expect(sandboxEnv).not.toHaveProperty("GH_CONFIG_DIR");
  });

  it.each([
    { previewName: "GH_TOKEN", otherName: "GITHUB_TOKEN" },
    { previewName: "GITHUB_TOKEN", otherName: "GH_TOKEN" },
  ] as const)(
    "scrubs only an explicitly owned $previewName preview variable",
    ({ previewName, otherName }) => {
      setTestEnvValue("GH_TOKEN", "ambient-token");
      setTestEnvValue("GITHUB_TOKEN", "ambient-fallback");
      const prepared = prepareGitHubToolEnvironment({
        config: {},
        sourceConfig: {
          gateway: {
            controlUi: {
              github: {
                token: { source: "env", provider: "default", id: previewName },
              },
            },
          },
        },
        agentId: "main",
      });

      const result = prepare("gateway", prepared, false);

      expect(result.env[previewName]).toBe("");
      expect(result.env[otherName]).toBe(
        otherName === "GH_TOKEN" ? "ambient-token" : "ambient-fallback",
      );
    },
  );

  it.each([
    { identity: "native", managed: false },
    { identity: "managed", managed: true },
  ])("blanks a custom preview env ref for $identity local and sandbox exec", ({ managed }) => {
    setTestEnvValue("GH_TOKEN", "ambient-token");
    setTestEnvValue("PREVIEW_SERVICE_TOKEN", "ambient-preview-token");
    const config = managed
      ? { tools: { github: { profileId: "ghp_77777777777777777777777777777777" } } }
      : {};
    const prepared = prepareGitHubToolEnvironment({
      config,
      sourceConfig: {
        gateway: {
          controlUi: {
            github: {
              token: { source: "env", provider: "default", id: "PREVIEW_SERVICE_TOKEN" },
            },
          },
        },
      },
      agentId: "main",
    });

    for (const host of ["gateway", "sandbox"] as const) {
      const result = prepare(host, prepared);
      expect(result.env.PREVIEW_SERVICE_TOKEN).toBe("");
      expect(result.requestedEnv?.PREVIEW_SERVICE_TOKEN).toBe("");
      expect(result.env.GH_TOKEN).toBe(managed ? "" : "store-sentinel");
      expect(result.env.GITHUB_TOKEN).toBe(managed ? "" : "store-sentinel");
    }
  });

  it.each([
    { identity: "native", managed: false },
    { identity: "managed", managed: true },
  ])(
    "excludes the preview store ref from $identity gateway exec projection",
    async ({ managed }) => {
      storeMocks.readSecretStoreExecEnvironment.mockReturnValue({ env: {} });
      const config = managed
        ? { tools: { github: { profileId: "ghp_88888888888888888888888888888888" } } }
        : {};
      const profileRoot = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "exec-github-identity-")),
      );
      try {
        const preparedRunEnvironment = prepareGitHubToolEnvironment({
          config,
          env: { OPENCLAW_STATE_DIR: profileRoot },
          sourceConfig: {
            gateway: {
              controlUi: {
                github: {
                  token: { source: "store", provider: "default", id: "PREVIEW_STORE_TOKEN" },
                },
              },
            },
          },
          agentId: "main",
        });
        if (managed) {
          const profileDir = expectDefined(
            preparedRunEnvironment.localIdentityEnv.GH_CONFIG_DIR,
            "managed GitHub profile",
          );
          await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
          await fs.writeFile(
            path.join(profileDir, "hosts.yml"),
            "github.com:\n  oauth_token: synthetic-managed-token\n",
            { mode: 0o600 },
          );
        }
        expect(preparedRunEnvironment.credentialScrubEnv.PREVIEW_STORE_TOKEN).toBe("");
        const tool = createExecTool({
          host: "gateway",
          security: "full",
          ask: "off",
          config,
          agentId: "main",
          preparedRunEnvironment,
        });

        await tool.execute(`store-ref-${managed ? "managed" : "native"}`, { command: "echo ok" });

        expect(storeMocks.readSecretStoreExecEnvironment).toHaveBeenCalledWith(
          expect.objectContaining({ excludeNames: ["PREVIEW_STORE_TOKEN"] }),
        );
      } finally {
        await fs.rm(profileRoot, { recursive: true, force: true });
      }
    },
  );
});
