// Codex tests cover app server policy plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveCodexAppServerForModelProvider } from "./app-server-policy.js";
import { assertCodexModelBackedReviewerEffectiveConfig } from "./config-reviewer.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";

describe("Codex app-server policy", () => {
  it("revalidates effective Guardian config at each boundary and skips human reviewers", async () => {
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

    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects reviewer endpoint changes on the same Codex process and workspace", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ config: { model_provider: "openai" }, origins: {} })
      .mockResolvedValueOnce({
        config: {
          model_provider: "openai",
          openai_base_url: "https://review-proxy.example.invalid/v1",
        },
        origins: {},
      });
    const params = {
      client: { request } as never,
      approvalsReviewer: "auto_review",
      cwd: "/workspace",
    } as const;

    await assertCodexModelBackedReviewerEffectiveConfig(params);
    await expect(assertCodexModelBackedReviewerEffectiveConfig(params)).rejects.toThrow(
      /trusted OpenAI endpoint/i,
    );

    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps concurrent reviewer attestations independent when one run aborts", async () => {
    const aborted = new AbortController();
    const healthy = new AbortController();
    const abortError = new Error("first run canceled");
    const request = vi.fn((_method: string, _params: unknown, options: { signal?: AbortSignal }) =>
      options.signal === aborted.signal
        ? new Promise((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(abortError), {
              once: true,
            });
          })
        : Promise.resolve({ config: { model_provider: "openai" }, origins: {} }),
    );
    const params = {
      client: { request } as never,
      approvalsReviewer: "auto_review",
      cwd: "/workspace",
    } as const;

    const first = assertCodexModelBackedReviewerEffectiveConfig({
      ...params,
      signal: aborted.signal,
    });
    const second = assertCodexModelBackedReviewerEffectiveConfig({
      ...params,
      signal: healthy.signal,
    });
    expect(request).toHaveBeenCalledTimes(2);
    const canceled = expect(first).rejects.toBe(abortError);
    aborted.abort(abortError);
    await Promise.all([canceled, expect(second).resolves.toBeUndefined()]);
  });

  it("revalidates Guardian trust across calls and workspaces on one Codex process", async () => {
    const request = vi.fn(async (_method: string, params: { cwd?: string }) => ({
      config:
        params.cwd === "/workspace/trusted"
          ? { model_provider: "openai" }
          : {
              model_provider: "openai",
              openai_base_url: "https://review-proxy.example.invalid/v1",
            },
      origins: {},
    }));
    const client = { request };

    await assertCodexModelBackedReviewerEffectiveConfig({
      client: client as never,
      approvalsReviewer: "auto_review",
      cwd: "/workspace/trusted",
    });
    await assertCodexModelBackedReviewerEffectiveConfig({
      client: client as never,
      approvalsReviewer: "guardian_subagent",
      cwd: "/workspace/trusted/.",
    });
    expect(request).toHaveBeenCalledTimes(2);

    await expect(
      assertCodexModelBackedReviewerEffectiveConfig({
        client: client as never,
        approvalsReviewer: "auto_review",
        cwd: "/workspace/untrusted",
      }),
    ).rejects.toThrow(/trusted OpenAI endpoint/i);
    expect(request).toHaveBeenCalledTimes(3);
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
