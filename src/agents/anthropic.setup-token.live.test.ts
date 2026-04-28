import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type Api, completeSimple, type Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_SETUP_TOKEN_PREFIX,
  validateAnthropicSetupToken,
} from "../commands/auth-token.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import {
  type AuthProfileCredential,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "./auth-profiles.js";
import { isLiveTestEnabled } from "./live-test-helpers.js";
import { getApiKeyForModel, requireApiKey } from "./model-auth.js";
import { normalizeProviderId, parseModelRef } from "./model-selection.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
import { discoverAuthStorage, discoverModels } from "./pi-model-discovery.js";

const LIVE = isLiveTestEnabled();
const SETUP_TOKEN_RAW = process.env.OPENCLAW_LIVE_SETUP_TOKEN?.trim() ?? "";
const SETUP_TOKEN_VALUE = process.env.OPENCLAW_LIVE_SETUP_TOKEN_VALUE?.trim() ?? "";
const SETUP_TOKEN_PROFILE = process.env.OPENCLAW_LIVE_SETUP_TOKEN_PROFILE?.trim() ?? "";
const SETUP_TOKEN_MODEL = process.env.OPENCLAW_LIVE_SETUP_TOKEN_MODEL?.trim() ?? "";

const ENABLED = LIVE && Boolean(SETUP_TOKEN_RAW || SETUP_TOKEN_VALUE || SETUP_TOKEN_PROFILE);
const describeLive = ENABLED ? describe : describe.skip;

type TokenSource = {
  agentDir: string;
  profileId: string;
  cleanup?: () => Promise<void>;
};

function isSetupToken(value: string): boolean {
  return value.startsWith(ANTHROPIC_SETUP_TOKEN_PREFIX);
}

function listSetupTokenProfiles(store: {
  profiles: Record<string, AuthProfileCredential>;
}): string[] {
  return Object.entries(store.profiles)
    .filter(([, cred]) => {
      if (cred.type !== "token") {
        return false;
      }
      if (normalizeProviderId(cred.provider) !== "anthropic") {
        return false;
      }
      return isSetupToken(cred.token ?? "");
    })
    .map(([id]) => id);
}

function pickSetupTokenProfile(candidates: string[]): string {
  const preferred = ["anthropic:setup-token-test", "anthropic:setup-token", "anthropic:default"];
  for (const id of preferred) {
    if (candidates.includes(id)) {
      return id;
    }
  }
  return candidates[0] ?? "";
}

async function resolveTokenSource(): Promise<TokenSource> {
  const explicitToken =
    (SETUP_TOKEN_RAW && isSetupToken(SETUP_TOKEN_RAW) ? SETUP_TOKEN_RAW : "") || SETUP_TOKEN_VALUE;

  if (explicitToken) {
    const error = validateAnthropicSetupToken(explicitToken);
    if (error) {
      throw new Error(`Invalid setup-token: ${error}`);
    }
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-setup-token-"));
    const profileId = `anthropic:setup-token-live-${randomUUID()}`;
    const store = ensureAuthProfileStore(tempDir, {
      allowKeychainPrompt: false,
    });
    store.profiles[profileId] = {
      type: "token",
      provider: "anthropic",
      token: explicitToken,
    };
    saveAuthProfileStore(store, tempDir);
    return {
      agentDir: tempDir,
      profileId,
      cleanup: async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
      },
    };
  }

  const agentDir = resolveOpenClawAgentDir();
  const store = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
  });

  const candidates = listSetupTokenProfiles(store);
  if (SETUP_TOKEN_PROFILE) {
    if (!candidates.includes(SETUP_TOKEN_PROFILE)) {
      const available = candidates.length > 0 ? candidates.join(", ") : "(none)";
      throw new Error(
        `Setup-token profile "${SETUP_TOKEN_PROFILE}" not found. Available: ${available}.`,
      );
    }
    return { agentDir, profileId: SETUP_TOKEN_PROFILE };
  }

  if (SETUP_TOKEN_RAW && SETUP_TOKEN_RAW !== "1" && SETUP_TOKEN_RAW !== "auto") {
    throw new Error(
      "OPENCLAW_LIVE_SETUP_TOKEN did not look like a setup-token. Use OPENCLAW_LIVE_SETUP_TOKEN_VALUE for raw tokens.",
    );
  }

  if (candidates.length === 0) {
    throw new Error(
      "No Anthropics setup-token profiles found. Set OPENCLAW_LIVE_SETUP_TOKEN_VALUE or OPENCLAW_LIVE_SETUP_TOKEN_PROFILE.",
    );
  }
  return { agentDir, profileId: pickSetupTokenProfile(candidates) };
}

function pickModel(models: Array<Model<Api>>, raw?: string): Model<Api> | null {
  const normalized = raw?.trim() ?? "";
  if (normalized) {
    const parsed = parseModelRef(normalized, "anthropic");
    if (!parsed) {
      return null;
    }
    return (
      models.find(
        (model) =>
          normalizeProviderId(model.provider) === parsed.provider && model.id === parsed.model,
      ) ?? null
    );
  }

  const preferred = [
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-sonnet-4-6",
    "claude-sonnet-4-0",
    "claude-haiku-3-5",
  ];
  for (const id of preferred) {
    const match = models.find((model) => model.id === id);
    if (match) {
      return match;
    }
  }
  return models[0] ?? null;
}

function buildTestModel(id: string, provider = "anthropic"): Model<Api> {
  return { id, provider } as Model<Api>;
}

describe("pickModel", () => {
  it("resolves sonnet-4.6 aliases to claude-sonnet-4-6", () => {
    const model = pickModel(
      [buildTestModel("claude-opus-4-6"), buildTestModel("claude-sonnet-4-6")],
      "sonnet-4.6",
    );
    expect(model?.id).toBe("claude-sonnet-4-6");
  });

  it("resolves opus-4.6 aliases to claude-opus-4-6", () => {
    const model = pickModel(
      [buildTestModel("claude-sonnet-4-6"), buildTestModel("claude-opus-4-6")],
      "opus-4.6",
    );
    expect(model?.id).toBe("claude-opus-4-6");
  });
});

describeLive("live anthropic setup-token", () => {
  it(
    "completes using a setup-token profile",
    async () => {
      const tokenSource = await resolveTokenSource();
      try {
        const cfg = getRuntimeConfig();
        await ensureOpenClawModelsJson(cfg, tokenSource.agentDir);

        const authStorage = discoverAuthStorage(tokenSource.agentDir);
        const modelRegistry = discoverModels(authStorage, tokenSource.agentDir);
        const all = Array.isArray(modelRegistry) ? modelRegistry : modelRegistry.getAll();
        const candidates = all.filter(
          (model) => normalizeProviderId(model.provider) === "anthropic",
        ) as Array<Model<Api>>;
        expect(candidates.length).toBeGreaterThan(0);

        const model = pickModel(candidates, SETUP_TOKEN_MODEL);
        if (!model) {
          throw new Error(
            SETUP_TOKEN_MODEL
              ? `Model not found: ${SETUP_TOKEN_MODEL}`
              : "No Anthropic models available.",
          );
        }

        const apiKeyInfo = await getApiKeyForModel({
          model,
          cfg,
          profileId: tokenSource.profileId,
          agentDir: tokenSource.agentDir,
        });
        const apiKey = requireApiKey(apiKeyInfo, model.provider);
        const tokenError = validateAnthropicSetupToken(apiKey);
        if (tokenError) {
          throw new Error(`Resolved profile is not a setup-token: ${tokenError}`);
        }

        const res = await completeSimple(
          model,
          {
            messages: [
              {
                role: "user",
                content: "Reply with the word ok.",
                timestamp: Date.now(),
              },
            ],
          },
          {
            apiKey,
            maxTokens: 64,
            temperature: 0,
          },
        );
        const text = res.content
          .filter((block) => block.type === "text")
          .map((block) => block.text.trim())
          .join(" ");
        expect(text.toLowerCase()).toContain("ok");
      } finally {
        if (tokenSource.cleanup) {
          await tokenSource.cleanup();
        }
      }
    },
    5 * 60 * 1000,
  );
});
