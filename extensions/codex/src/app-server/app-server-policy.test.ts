// Codex tests cover app server policy plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveCodexAppServerForModelProvider } from "./app-server-policy.js";
import { assertCodexModelBackedReviewerEffectiveConfig } from "./config-reviewer.js";
import { withMcpElicitationsApprovalPolicy } from "./config-security.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";

describe("Codex app-server policy", () => {
  it("preserves mandatory per-command approvals while permitting MCP elicitation", () => {
    expect(withMcpElicitationsApprovalPolicy("untrusted")).toBe("untrusted");
  });

  it("caches effective Guardian config by Codex process and skips human reviewers", async () => {
    const request = vi.fn(async () => ({ config: { model_provider: "openai" }, origins: {} }));
    const client = { request };
    const params = { client: client as never, cwd: "/workspace" };

    await assertCodexModelBackedReviewerEffectiveConfig({ ...params, approvalsReviewer: "user" });
    expect(request).not.toHaveBeenCalled();
    await assertCodexModelBackedReviewerEffectiveConfig({
      ...params,
      approvalsReviewer: "auto_review",
    });
    await assertCodexModelBackedReviewerEffectiveConfig({
      ...params,
      approvalsReviewer: "guardian_subagent",
    });

    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "missing effective config", response: {} },
    { name: "alternate model provider", response: { config: { model_provider: "custom" } } },
    {
      name: "managed ChatGPT endpoint",
      response: { config: { chatgpt_base_url: "https://review-proxy.example.invalid" } },
    },
    {
      name: "managed model-provider endpoint",
      response: {
        config: { model_providers: { openai: { base_url: "https://proxy.example.invalid/v1" } } },
      },
    },
  ])("fails Guardian review closed on $name", async ({ response }) => {
    const client = { request: vi.fn(async () => response) };

    await expect(
      assertCodexModelBackedReviewerEffectiveConfig({
        client: client as never,
        approvalsReviewer: "auto_review",
        cwd: "/workspace",
      }),
    ).rejects.toThrow(/reviewer/i);
  });

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

  it("checks the actual app-server home instead of the caller's ambient Codex home", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-review-home-"));
    try {
      const ambientHome = path.join(root, "ambient");
      const effectiveHome = path.join(root, "effective");
      await Promise.all([
        fs.mkdir(ambientHome, { recursive: true }),
        fs.mkdir(effectiveHome, { recursive: true }),
      ]);
      await fs.writeFile(
        path.join(effectiveHome, "config.toml"),
        'openai_base_url = "http://localhost:8080/v1"\n',
      );
      const appServer = resolveCodexAppServerRuntimeOptions({
        env: {},
        requirementsToml: null,
        execMode: "auto",
        modelProvider: "openai",
        model: "gpt-5.5",
        pluginConfig: { appServer: { homeScope: "user" } },
      });

      const resolved = resolveCodexAppServerForModelProvider({
        appServer: {
          ...appServer,
          start: { ...appServer.start, env: { CODEX_HOME: effectiveHome } },
        },
        provider: "openai",
        model: "gpt-5.5",
        env: { CODEX_HOME: ambientHome },
      });

      expect(resolved.approvalsReviewer).toBe("user");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("checks endpoint overrides applied to the actual app-server process", () => {
    const appServer = resolveCodexAppServerRuntimeOptions({
      env: {},
      requirementsToml: null,
      execMode: "auto",
      modelProvider: "openai",
      model: "gpt-5.5",
    });

    expect(
      resolveCodexAppServerForModelProvider({
        appServer: {
          ...appServer,
          start: {
            ...appServer.start,
            env: { OPENAI_BASE_URL: "http://localhost:8080/v1" },
          },
        },
        provider: "openai",
        model: "gpt-5.5",
        env: {},
      }).approvalsReviewer,
    ).toBe("user");
  });

  it("checks the selected native profile before trusting model-backed review", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-review-profile-"));
    try {
      await fs.writeFile(
        path.join(codexHome, "work.config.toml"),
        'openai_base_url = "http://localhost:8080/v1"\n',
      );
      const appServer = resolveCodexAppServerRuntimeOptions({
        env: {},
        requirementsToml: null,
        execMode: "auto",
        modelProvider: "openai",
        model: "gpt-5.5",
        pluginConfig: { appServer: { homeScope: "user" } },
      });

      expect(
        resolveCodexAppServerForModelProvider({
          appServer: {
            ...appServer,
            start: {
              ...appServer.start,
              args: ["--profile", "work", "app-server"],
              env: { CODEX_HOME: codexHome },
            },
          },
          provider: "openai",
          model: "gpt-5.5",
          env: {},
        }).approvalsReviewer,
      ).toBe("user");
    } finally {
      await fs.rm(codexHome, { recursive: true, force: true });
    }
  });

  it("checks native command-line endpoint overrides before trusting model-backed review", () => {
    const appServer = resolveCodexAppServerRuntimeOptions({
      env: {},
      requirementsToml: null,
      execMode: "auto",
      modelProvider: "openai",
      model: "gpt-5.5",
    });

    expect(
      resolveCodexAppServerForModelProvider({
        appServer: {
          ...appServer,
          start: {
            ...appServer.start,
            args: ["app-server", "-c", 'openai_base_url="http://localhost:8080/v1"'],
          },
        },
        provider: "openai",
        model: "gpt-5.5",
        env: {},
      }).approvalsReviewer,
    ).toBe("user");
  });
});
