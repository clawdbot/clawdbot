import path from "node:path";
import { expect, it } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { OpenClawSchema } from "../../config/zod-schema.js";
import { applyModelOverrideWithAuthProfileCompatibility } from "../../sessions/auth-profile-preservation.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveModelWithRegistry } from "../embedded-agent-runner/model.registry-resolution.js";
import { AuthStorage } from "../sessions/auth-storage.js";
import { ModelRegistry } from "../sessions/model-registry.js";
import { resolveSessionAuthSelection } from "./session-override.js";

it.each([
  {
    name: "preserves the user account",
    source: "user",
    pin: "arcee:work",
    modelEndpoint: "https://api.arcee.ai/api/v1",
    expectedPin: "arcee:work",
    expectedSource: "user",
    agentId: "main",
  },
  {
    name: "preserves a person-linked account",
    source: "user-link",
    pin: "arcee:work",
    modelEndpoint: "https://api.arcee.ai/api/v1",
    expectedPin: "arcee:work",
    expectedSource: "user-link",
    agentId: "writer",
  },
  {
    name: "rejects a truly incompatible pin",
    source: "user",
    pin: "openrouter:default",
    modelEndpoint: "https://api.arcee.ai/api/v1",
    expectedPin: "arcee:other",
    expectedSource: "auto",
    agentId: "main",
  },
  {
    name: "honors configured order for automatic selection",
    source: "auto",
    pin: "arcee:work",
    modelEndpoint: "https://api.arcee.ai/api/v1",
    expectedPin: "arcee:other",
    expectedSource: "auto",
    agentId: "main",
  },
  {
    name: "keeps ordinary OpenRouter ownership",
    source: "user",
    pin: "openrouter:default",
    modelEndpoint: "https://openrouter.ai/api/v1",
    expectedPin: "openrouter:default",
    expectedSource: "user",
    agentId: "main",
  },
] as const)(
  "$name for a configured model endpoint before session mutation",
  async ({ source, pin, modelEndpoint, expectedPin, expectedSource, agentId }) => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "session-endpoint-pin-" },
      async (state) => {
        const cfg: OpenClawConfig = {
          plugins: { allow: ["arcee"] },
          auth: {
            profiles: {
              "arcee:work": { provider: "arcee", mode: "api_key" },
              "arcee:other": { provider: "arcee", mode: "api_key" },
              "openrouter:default": { provider: "openrouter", mode: "api_key" },
            },
            order: { arcee: ["arcee:other", "arcee:work"], openrouter: ["openrouter:default"] },
          },
          models: {
            providers: {
              arcee: {
                baseUrl: "https://openrouter.ai/api/v1",
                api: "openai-completions",
                models: [
                  {
                    id: "trinity-large-thinking",
                    name: "Direct account model",
                    api: "openai-completions",
                    baseUrl: modelEndpoint,
                    reasoning: true,
                    input: ["text"],
                    contextWindow: 32768,
                    maxTokens: 2048,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  },
                ],
              },
            },
          },
        };
        expect(OpenClawSchema.safeParse(cfg).success).toBe(true);
        await state.writeConfig(cfg);
        await state.writeAuthProfiles(
          {
            version: 1,
            profiles: {
              "arcee:work": { type: "api_key", provider: "arcee", key: "synthetic-work-key" },
              "arcee:other": { type: "api_key", provider: "arcee", key: "synthetic-other-key" },
              "openrouter:default": {
                type: "api_key",
                provider: "openrouter",
                key: "synthetic-router-key",
              },
            },
          },
          agentId,
        );
        const model = resolveModelWithRegistry({
          cfg,
          provider: "arcee",
          modelId: "trinity-large-thinking",
          agentDir: state.agentDir(agentId),
          modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
        });
        expect(model?.baseUrl).toBe(modelEndpoint);

        const sessionKey = `agent:${agentId}:endpoint-pin`;
        const sessionEntry: SessionEntry = {
          sessionId: "endpoint-pin-session",
          updatedAt: 1,
          providerOverride: "arcee",
          modelOverride: "trinity-large-thinking",
          model: "trinity-large-thinking",
          authProfileOverride: pin,
          authProfileOverrideSource: source,
        };
        const scope = {
          storePath: path.join(state.sessionsDir(agentId), "sessions.json"),
          sessionKey,
        };
        await replaceSessionEntry(scope, sessionEntry);
        const selection = await resolveSessionAuthSelection({
          cfg,
          provider: "arcee",
          modelId: "trinity-large-thinking",
          agentDir: state.agentDir(agentId),
          sessionEntry,
          sessionStore: { [sessionKey]: sessionEntry },
          ...scope,
          isNewSession: source === "auto",
        });

        expect.soft(selection).toMatchObject({
          profileId: expectedPin,
          source: expectedSource === "user-link" ? "user" : expectedSource,
        });
        expect.soft(sessionEntry.authProfileOverride).toBe(expectedPin);
        expect.soft(loadSessionEntry({ ...scope, readConsistency: "latest" })).toMatchObject({
          authProfileOverride: expectedPin,
          authProfileOverrideSource: expectedSource,
        });
        if (source === "user" && pin === "arcee:work") {
          applyModelOverrideWithAuthProfileCompatibility({
            cfg,
            agentDir: state.agentDir(agentId),
            entry: sessionEntry,
            currentProvider: "arcee",
            selection: { provider: "arcee", model: "trinity-large-thinking" },
          });
          expect(sessionEntry.authProfileOverride).toBe("arcee:work");
          expect(sessionEntry.authProfileOverrideSource).toBe("user");
        }
      },
    );
  },
);
