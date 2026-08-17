import { afterEach, describe, expect, it, vi } from "vitest";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { resolvePreparedExecEnvironment } from "./bash-tools.exec-request-preparation.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { prepareGitHubCredentialIsolation } from "./github-service-credential-isolation.js";

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
  host: "gateway" | "node" | "sandbox",
  credentialScrubEnv: Readonly<Record<string, string>>,
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
    storeSecretEnv: { GH_TOKEN: "store-sentinel", GITHUB_TOKEN: "store-sentinel" },
    credentialScrubEnv,
    warnings: [],
  });
}

describe("exec GitHub service credential isolation", () => {
  it("does not restore ambient service tokens on any host", () => {
    setTestEnvValue("GH_TOKEN", "ambient-token");
    setTestEnvValue("GITHUB_TOKEN", "ambient-fallback");
    const prepared = prepareGitHubCredentialIsolation({ config: {} });

    for (const host of ["gateway", "node", "sandbox"] as const) {
      const result = prepare(host, prepared.credentialScrubEnv);
      expect(result.env.GH_TOKEN).toBe("");
      expect(result.env.GITHUB_TOKEN).toBe("");
      expect(result.requestedEnv?.GH_TOKEN).toBe("");
      expect(result.requestedEnv?.GITHUB_TOKEN).toBe("");
    }
  });

  it("blanks a custom preview env ref on every host", () => {
    setTestEnvValue("PREVIEW_SERVICE_TOKEN", "ambient-preview-token");
    const prepared = prepareGitHubCredentialIsolation({
      config: {},
      sourceConfig: {
        gateway: {
          controlUi: {
            github: {
              token: { source: "env", provider: "default", id: "PREVIEW_SERVICE_TOKEN" },
            },
          },
        },
      },
    });

    for (const host of ["gateway", "node", "sandbox"] as const) {
      const result = prepare(host, prepared.credentialScrubEnv);
      expect(result.env.PREVIEW_SERVICE_TOKEN).toBe("");
      expect(result.requestedEnv?.PREVIEW_SERVICE_TOKEN).toBe("");
    }
  });

  it("excludes the preview store ref from gateway exec projection", async () => {
    storeMocks.readSecretStoreExecEnvironment.mockReturnValue({ env: {} });
    const preparedCredentialIsolation = prepareGitHubCredentialIsolation({
      config: {},
      sourceConfig: {
        gateway: {
          controlUi: {
            github: {
              token: { source: "store", provider: "default", id: "PREVIEW_STORE_TOKEN" },
            },
          },
        },
      },
    });
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      config: {},
      agentId: "main",
      preparedCredentialIsolation,
    });

    await tool.execute("store-ref-native", { command: "echo ok" });

    expect(storeMocks.readSecretStoreExecEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({ excludeNames: ["PREVIEW_STORE_TOKEN"] }),
    );
  });
});
