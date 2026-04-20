import { describe, expect, it, vi } from "vitest";
import { buildBeforeModelResolveAttachments, resolveHookModelSelection } from "./setup.js";

const hookContext = {
  sessionId: "session-1",
  workspaceDir: "/tmp/workspace",
};

describe("buildBeforeModelResolveAttachments", () => {
  it("maps prompt image metadata to before_model_resolve attachments", () => {
    expect(
      buildBeforeModelResolveAttachments([{ mimeType: "image/png" }, { mimeType: "image/jpeg" }]),
    ).toEqual([
      { kind: "image", mimeType: "image/png" },
      { kind: "image", mimeType: "image/jpeg" },
    ]);
  });

  it("omits attachments when there are no images", () => {
    expect(buildBeforeModelResolveAttachments(undefined)).toBeUndefined();
    expect(buildBeforeModelResolveAttachments([])).toBeUndefined();
  });
});

describe("resolveHookModelSelection", () => {
  it("passes attachment metadata to before_model_resolve hooks", async () => {
    const attachments = [{ kind: "image" as const, mimeType: "image/png" }];
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_model_resolve"),
      runBeforeModelResolve: vi.fn(async () => ({
        providerOverride: "vision-provider",
        modelOverride: "vision-model",
      })),
      runBeforeAgentStart: vi.fn(),
    };

    const result = await resolveHookModelSelection({
      prompt: "describe this image",
      attachments,
      provider: "default-provider",
      modelId: "default-model",
      hookRunner,
      hookContext,
    });

    expect(hookRunner.runBeforeModelResolve).toHaveBeenCalledWith(
      { prompt: "describe this image", attachments },
      hookContext,
    );
    expect(hookRunner.runBeforeAgentStart).not.toHaveBeenCalled();
    expect(result.provider).toBe("vision-provider");
    expect(result.modelId).toBe("vision-model");
  });

  it("omits the attachments key for text-only before_model_resolve hooks", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_model_resolve"),
      runBeforeModelResolve: vi.fn(async () => undefined),
      runBeforeAgentStart: vi.fn(),
    };

    await resolveHookModelSelection({
      prompt: "text only",
      provider: "default-provider",
      modelId: "default-model",
      hookRunner,
      hookContext,
    });

    expect(hookRunner.runBeforeModelResolve).toHaveBeenCalledWith(
      { prompt: "text only" },
      hookContext,
    );
  });
});
