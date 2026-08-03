// Approval-intent tests: closed-list fast path plus model-judged classification.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  classifySystemAgentApprovalIntent,
  classifySystemAgentApprovalText,
  type SystemAgentApprovalIntentDeps,
} from "./approval-intent.js";
import {
  createSystemAgentVerifiedInferenceTestFixture,
  installSystemAgentClaudeCliBackendTestFixture,
  installSystemAgentPluginMetadataTestSnapshot,
  type SystemAgentPluginMetadataTestSnapshot,
} from "./system-agent.test-helpers.js";
import type { SystemAgentVerifiedInferenceBinding } from "./verified-inference.js";

const DEFAULT_MODEL = "openai/gpt-5.5@openai:p2";
const CLI_MODEL = "claude-cli/claude-opus-4-8";

function verifiedInferenceConfig(model: string): OpenClawConfig {
  const openClawRuntime = model.startsWith("openai/")
    ? {
        models: {
          "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
        },
      }
    : {};
  return {
    agents: { defaults: { model, ...openClawRuntime } },
    auth: {
      order: { openai: ["openai:p1", "openai:p2"] },
      profiles: {
        "openai:p1": { provider: "openai", mode: "api_key" },
        "openai:p2": { provider: "openai", mode: "api_key" },
      },
    },
  };
}

async function createVerifiedInference(
  model = "openai/gpt-5.5@openai:p2",
): Promise<SystemAgentVerifiedInferenceBinding> {
  return (await createSystemAgentVerifiedInferenceTestFixture(verifiedInferenceConfig(model)))
    .binding;
}

let sharedVerifiedInference: SystemAgentVerifiedInferenceBinding | undefined;
let restoreCliBackendFixture: (() => void) | undefined;
let cliPluginMetadataSnapshot: SystemAgentPluginMetadataTestSnapshot | undefined;

beforeAll(async () => {
  restoreCliBackendFixture = installSystemAgentClaudeCliBackendTestFixture();
  const defaultSnapshot = installSystemAgentPluginMetadataTestSnapshot(
    verifiedInferenceConfig(DEFAULT_MODEL),
  );
  try {
    sharedVerifiedInference = await createVerifiedInference(DEFAULT_MODEL);
  } finally {
    defaultSnapshot.restore();
  }
  cliPluginMetadataSnapshot = installSystemAgentPluginMetadataTestSnapshot(
    verifiedInferenceConfig(CLI_MODEL),
  );
});

afterAll(() => {
  restoreCliBackendFixture?.();
  cliPluginMetadataSnapshot?.restore();
});

function requireSharedVerifiedInference(): SystemAgentVerifiedInferenceBinding {
  if (!sharedVerifiedInference) {
    throw new Error("shared verified inference fixture was not initialized");
  }
  return sharedVerifiedInference;
}

function completionDeps(replyText: string, binding: SystemAgentVerifiedInferenceBinding) {
  const route = binding.execution;
  return {
    resolveVerifiedInferenceRoute: vi.fn<
      NonNullable<SystemAgentApprovalIntentDeps["resolveVerifiedInferenceRoute"]>
    >(async () => route),
    prepareSimpleCompletionModelForAgent: vi.fn<
      NonNullable<SystemAgentApprovalIntentDeps["prepareSimpleCompletionModelForAgent"]>
    >(
      async () =>
        ({
          model: {},
          auth: { profileId: route.authProfileId },
          sourceAuthFingerprint: binding.auth.authFingerprint,
          selection: {
            provider: route.provider,
            modelId: route.model,
            profileId: route.authProfileId,
            agentDir: route.agentDir,
          },
        }) as never,
    ),
    completeWithPreparedSimpleCompletionModel: vi.fn<
      NonNullable<SystemAgentApprovalIntentDeps["completeWithPreparedSimpleCompletionModel"]>
    >(
      async () =>
        ({
          content: [{ type: "text", text: replyText }],
        }) as never,
    ),
  };
}

describe("classifySystemAgentApprovalText", () => {
  it("accepts natural affirmatives regardless of case and punctuation", () => {
    for (const text of ["yes", "Yes.", "sure", "ok!", "Okay,", "go ahead", "yes please", "do it"]) {
      expect(classifySystemAgentApprovalText(text)).toBe("approve");
    }
  });

  it("treats clear rejections as declines", () => {
    for (const text of ["no", "no thanks", "not now", "cancel", "don't", "nah, later"]) {
      expect(classifySystemAgentApprovalText(text)).toBe("decline");
    }
  });

  it("keeps everything ambiguous as other", () => {
    for (const text of ["maybe", "what does that change?", "yes but use gpt instead", ""]) {
      expect(classifySystemAgentApprovalText(text)).toBe("other");
    }
  });
});

describe("classifySystemAgentApprovalIntent", () => {
  it("short-circuits closed-list answers without a model call", async () => {
    const binding = requireSharedVerifiedInference();
    const deps = completionDeps("approve", binding);
    await expect(
      classifySystemAgentApprovalIntent({ message: "yes", verifiedInference: binding }, deps),
    ).resolves.toBe("approve");
    expect(deps.resolveVerifiedInferenceRoute).not.toHaveBeenCalled();
    expect(deps.completeWithPreparedSimpleCompletionModel).not.toHaveBeenCalled();
  });

  it("pins ambiguous approvals to the verified model and profile", async () => {
    const binding = requireSharedVerifiedInference();
    const deps = completionDeps("approve", binding);
    await expect(
      classifySystemAgentApprovalIntent(
        {
          message: "alright, ship that change",
          proposal: "set config gateway.port to 19001",
          verifiedInference: binding,
        },
        deps,
      ),
    ).resolves.toBe("approve");
    expect(deps.prepareSimpleCompletionModelForAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: binding.execution.agentDir,
        modelRef: "openai/gpt-5.5@openai:p2",
        preferredProfile: "openai:p2",
      }),
    );
    expect(deps.completeWithPreparedSimpleCompletionModel).toHaveBeenCalledOnce();
  });

  it("fails closed to other on unexpected model output", async () => {
    const binding = requireSharedVerifiedInference();
    const deps = completionDeps("I think the user probably agrees", binding);
    await expect(
      classifySystemAgentApprovalIntent(
        { message: "hmm alright I guess?", verifiedInference: binding },
        deps,
      ),
    ).resolves.toBe("other");
  });

  it("fails closed to other when no model is usable", async () => {
    const binding = requireSharedVerifiedInference();
    const deps = {
      ...completionDeps("approve", binding),
      prepareSimpleCompletionModelForAgent: vi.fn(async () => ({ error: "no model" })) as never,
    };
    await expect(
      classifySystemAgentApprovalIntent(
        { message: "alright then", verifiedInference: binding },
        deps,
      ),
    ).resolves.toBe("other");
  });

  it("rejects a prepared auth owner that differs from the verified profile", async () => {
    const binding = requireSharedVerifiedInference();
    const deps = completionDeps("approve", binding);
    deps.prepareSimpleCompletionModelForAgent.mockResolvedValueOnce({
      model: {},
      auth: { profileId: "openai:p1" },
      selection: {
        provider: "openai",
        modelId: "gpt-5.5",
        profileId: "openai:p1",
        agentDir: binding.execution.agentDir,
      },
    } as never);

    await expect(
      classifySystemAgentApprovalIntent(
        { message: "alright then", verifiedInference: binding },
        deps,
      ),
    ).resolves.toBe("other");
    expect(deps.completeWithPreparedSimpleCompletionModel).not.toHaveBeenCalled();
  });

  it("rejects a same-profile credential rotation during preparation", async () => {
    const binding = requireSharedVerifiedInference();
    const deps = completionDeps("approve", binding);
    deps.prepareSimpleCompletionModelForAgent.mockResolvedValueOnce({
      model: {},
      auth: { profileId: "openai:p2" },
      sourceAuthFingerprint: "different-p2-owner",
      selection: {
        provider: "openai",
        modelId: "gpt-5.5",
        profileId: "openai:p2",
        agentDir: binding.execution.agentDir,
      },
    } as never);

    await expect(
      classifySystemAgentApprovalIntent(
        { message: "alright then", verifiedInference: binding },
        deps,
      ),
    ).resolves.toBe("other");
    expect(deps.completeWithPreparedSimpleCompletionModel).not.toHaveBeenCalled();
  });

  it("keeps ambiguous CLI approvals on the exact-text path", async () => {
    const binding = await createVerifiedInference(CLI_MODEL);
    const deps = completionDeps("approve", binding);

    await expect(
      classifySystemAgentApprovalIntent(
        { message: "alright then", verifiedInference: binding },
        deps,
      ),
    ).resolves.toBe("other");
    expect(deps.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });

  it("rejects a verdict when the verified owner drifts during classification", async () => {
    const binding = await createVerifiedInference(DEFAULT_MODEL);
    const deps = completionDeps("approve", binding);
    deps.resolveVerifiedInferenceRoute
      .mockResolvedValueOnce(binding.execution)
      .mockResolvedValueOnce(null);

    await expect(
      classifySystemAgentApprovalIntent(
        { message: "alright then", verifiedInference: binding },
        deps,
      ),
    ).resolves.toBe("other");
  });
});
