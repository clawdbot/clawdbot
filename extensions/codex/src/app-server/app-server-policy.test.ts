// Codex tests cover app server policy plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveCodexAppServerForModelProvider } from "./app-server-policy.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";

describe("Codex app-server policy", () => {
  it("keeps model-backed reviewers for explicit OpenAI model providers", () => {
    const appServer = resolveCodexAppServerRuntimeOptions({
      env: {},
      requirementsToml: null,
      execMode: "auto",
      modelProvider: "openai",
    });

    expect(
      resolveCodexAppServerForModelProvider({
        appServer,
        provider: "codex",
        model: "openai/gpt-5.5",
      }).approvalsReviewer,
    ).toBe("auto_review");
    expect(
      resolveCodexAppServerForModelProvider({
        appServer,
        provider: "codex",
        model: "gpt-5.5",
      }).approvalsReviewer,
    ).toBe("user");
    expect(
      resolveCodexAppServerForModelProvider({ appServer, provider: "openai" }).approvalsReviewer,
    ).toBe("auto_review");
  });

  it("uses human approval for OpenAI-compatible custom endpoints", () => {
    const appServer = resolveCodexAppServerRuntimeOptions({
      env: {},
      requirementsToml: null,
      execMode: "auto",
      modelProvider: "openai",
      model: "gpt-5.5",
      config: {
        models: {
          providers: {
            openai: {
              baseUrl: "http://localhost:8080/v1",
              models: [],
            },
          },
        },
      },
    });

    expect(appServer.approvalsReviewer).toBe("user");
    expect(
      resolveCodexAppServerForModelProvider({
        appServer,
        provider: "openai",
        model: "gpt-5.5",
        config: {
          models: {
            providers: {
              openai: {
                baseUrl: "http://localhost:8080/v1",
                models: [],
              },
            },
          },
        },
      }).approvalsReviewer,
    ).toBe("user");
  });

  it("uses human approval instead of Codex Guardian for custom model providers", () => {
    const appServer = resolveCodexAppServerRuntimeOptions({
      env: {},
      requirementsToml: null,
      execMode: "auto",
      modelProvider: "openai",
    });

    const resolved = resolveCodexAppServerForModelProvider({
      appServer,
      provider: "lmstudio",
    });
    const vendorPrefixedModel = resolveCodexAppServerForModelProvider({
      appServer,
      provider: "openrouter",
      model: "openai/gpt-5.5",
    });

    expect(appServer.approvalsReviewer).toBe("auto_review");
    expect(resolved.approvalPolicy).toBe("on-request");
    expect(resolved.sandbox).toBe("workspace-write");
    expect(resolved.approvalsReviewer).toBe("user");
    expect(vendorPrefixedModel.approvalsReviewer).toBe("user");
  });

  it("infers custom providers from provider-qualified model refs", () => {
    const appServer = resolveCodexAppServerRuntimeOptions({
      env: {},
      requirementsToml: null,
      execMode: "auto",
    });

    expect(
      resolveCodexAppServerForModelProvider({
        appServer,
        model: "lmstudio/local-model",
      }).approvalsReviewer,
    ).toBe("user");
  });

  it("uses provider-qualified model refs to override broad native provider wrappers", () => {
    const appServer = resolveCodexAppServerRuntimeOptions({
      env: {},
      requirementsToml: null,
      execMode: "auto",
    });

    expect(
      resolveCodexAppServerForModelProvider({
        appServer,
        provider: "codex",
        model: "lmstudio/local-model",
      }).approvalsReviewer,
    ).toBe("user");
  });

  it("downgrades legacy guardian_subagent for custom model providers", () => {
    const appServer = resolveCodexAppServerRuntimeOptions({
      env: {},
      requirementsToml: null,
      pluginConfig: {
        appServer: {
          mode: "guardian",
          approvalsReviewer: "guardian_subagent",
        },
      },
    });

    expect(
      resolveCodexAppServerForModelProvider({ appServer, provider: "local" }).approvalsReviewer,
    ).toBe("user");
  });
});
