/** Tests for TTS SecretRef assignment ownership. */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { collectTtsApiKeyAssignments } from "./runtime-config-collectors-tts.js";
import { createResolverContext } from "./runtime-shared.js";

const TTS_KEY_REF = {
  source: "env",
  provider: "default",
  id: "ELEVENLABS_API_KEY",
} as const;

function createContext() {
  return createResolverContext({
    sourceConfig: {} as OpenClawConfig,
    env: {},
  });
}

describe("collectTtsApiKeyAssignments", () => {
  it("assigns active TTS provider SecretRefs to the shared TTS capability owner", () => {
    const tts = {
      providers: {
        elevenlabs: {
          apiKey: TTS_KEY_REF,
        },
      },
    };
    const context = createContext();

    collectTtsApiKeyAssignments({
      tts,
      pathPrefix: "tts",
      defaults: undefined,
      context,
    });

    expect(context.assignments).toHaveLength(1);
    expect(context.assignments[0]).toMatchObject({
      path: "tts.providers.elevenlabs.apiKey",
      expected: "string",
      ownerKind: "capability",
      ownerId: "tts",
      requiredForGateway: false,
      disposition: "isolate",
    });

    const resolved = "redacted";
    context.assignments[0]?.apply(resolved);
    expect(tts.providers.elevenlabs.apiKey).toBe(resolved);
  });

  it("keeps inactive TTS provider SecretRefs out of resolution", () => {
    const tts = {
      providers: {
        elevenlabs: {
          apiKey: TTS_KEY_REF,
        },
      },
    };
    const context = createContext();

    collectTtsApiKeyAssignments({
      tts,
      pathPrefix: "agents.list.0.tts",
      defaults: undefined,
      context,
      active: false,
      inactiveReason: "agent is disabled.",
    });

    expect(context.assignments).toEqual([]);
    expect(context.warnings).toMatchObject([
      {
        code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
        path: "agents.list.0.tts.providers.elevenlabs.apiKey",
      },
    ]);
    expect(tts.providers.elevenlabs.apiKey).toEqual(TTS_KEY_REF);
  });
});
