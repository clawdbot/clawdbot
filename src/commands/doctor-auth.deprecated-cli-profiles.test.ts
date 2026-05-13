import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { maybeRepairLegacyOAuthProfileIds } from "./doctor-auth-legacy-oauth.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import type { DoctorRepairMode } from "./doctor-repair-mode.js";

const resolvePluginProvidersMock = vi.fn<() => ProviderPlugin[]>(() => []);
const authProfileStoreMock = vi.hoisted(() => ({
  store: { version: 1, profiles: {} } as AuthProfileStore,
}));
const repairMocks = vi.hoisted(() => ({
  repairOAuthProfileIdMismatch: vi.fn(),
}));

vi.mock("../plugins/providers.runtime.js", () => ({
  resolvePluginProviders: () => resolvePluginProvidersMock(),
}));

vi.mock("../agents/auth-profiles/repair.js", () => ({
  repairOAuthProfileIdMismatch: repairMocks.repairOAuthProfileIdMismatch,
}));

vi.mock("../agents/auth-profiles/store.js", () => ({
  ensureAuthProfileStore: () => authProfileStoreMock.store,
}));

vi.mock("../terminal/note.js", () => ({
  note: vi.fn(),
}));

function makePrompter(confirmValue: boolean): DoctorPrompter {
  const repairMode: DoctorRepairMode = {
    shouldRepair: confirmValue,
    shouldForce: false,
    nonInteractive: false,
    canPrompt: true,
    updateInProgress: false,
  };
  return {
    confirm: vi.fn().mockResolvedValue(confirmValue),
    confirmAutoFix: vi.fn().mockResolvedValue(confirmValue),
    confirmAggressiveAutoFix: vi.fn().mockResolvedValue(confirmValue),
    confirmRuntimeRepair: vi.fn().mockResolvedValue(confirmValue),
    select: vi.fn().mockResolvedValue(""),
    shouldRepair: repairMode.shouldRepair,
    shouldForce: repairMode.shouldForce,
    repairMode,
  };
}

function requireAuthConfig(config: OpenClawConfig): NonNullable<OpenClawConfig["auth"]> {
  if (!config.auth) {
    throw new Error("expected repaired auth config");
  }
  return config.auth;
}

function requireFirstMockArg<T>(mock: { mock: { calls: T[][] } }, label: string): T {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  const [arg] = call;
  return arg;
}

beforeEach(() => {
  resolvePluginProvidersMock.mockReset();
  resolvePluginProvidersMock.mockReturnValue([]);
  authProfileStoreMock.store = { version: 1, profiles: {} };
  repairMocks.repairOAuthProfileIdMismatch.mockReset();
  repairMocks.repairOAuthProfileIdMismatch.mockReturnValue({
    config: {},
    changes: [],
    migrated: false,
  });
});

describe("maybeRepairLegacyOAuthProfileIds", () => {
  it("skips provider loading when config has no legacy OAuth profiles", async () => {
    const cfg = { channels: { telegram: { enabled: true } } } as OpenClawConfig;

    const next = await maybeRepairLegacyOAuthProfileIds(cfg, makePrompter(true));

    expect(next).toBe(cfg);
    expect(resolvePluginProvidersMock).not.toHaveBeenCalled();
    expect(repairMocks.repairOAuthProfileIdMismatch).not.toHaveBeenCalled();
  });

  it("repairs provider-owned legacy OAuth profile ids", async () => {
    authProfileStoreMock.store = {
      version: 1,
      profiles: {
        "anthropic:user@example.com": {
          type: "oauth",
          provider: "anthropic",
          access: "token-a",
          refresh: "token-r",
          expires: Date.now() + 60_000,
          email: "user@example.com",
        },
      },
      lastGood: {
        anthropic: "anthropic:user@example.com",
      },
    };

    resolvePluginProvidersMock.mockReturnValue([
      {
        id: "anthropic",
        label: "Anthropic",
        auth: [],
        oauthProfileIdRepairs: [{ legacyProfileId: "anthropic:default" }],
      },
    ]);
    repairMocks.repairOAuthProfileIdMismatch.mockReturnValue({
      migrated: true,
      changes: ["Auth: migrate anthropic:default → anthropic:user@example.com"],
      config: {
        auth: {
          profiles: {
            "anthropic:user@example.com": {
              provider: "anthropic",
              mode: "oauth",
              email: "user@example.com",
            },
          },
          order: {
            anthropic: ["anthropic:user@example.com"],
          },
        },
      },
    });

    const next = await maybeRepairLegacyOAuthProfileIds(
      {
        auth: {
          profiles: {
            "anthropic:default": { provider: "anthropic", mode: "oauth" },
          },
          order: {
            anthropic: ["anthropic:default"],
          },
        },
      } as OpenClawConfig,
      makePrompter(true),
    );

    expect(repairMocks.repairOAuthProfileIdMismatch).toHaveBeenCalledOnce();
    const repairCall = requireFirstMockArg(
      repairMocks.repairOAuthProfileIdMismatch,
      "OAuth profile repair",
    ) as {
      cfg?: OpenClawConfig;
      store?: AuthProfileStore;
      provider?: unknown;
      legacyProfileId?: unknown;
    };
    expect(repairCall.cfg?.auth?.profiles?.["anthropic:default"]).toEqual({
      provider: "anthropic",
      mode: "oauth",
    });
    expect(repairCall.store).toBe(authProfileStoreMock.store);
    expect(repairCall.provider).toBe("anthropic");
    expect(repairCall.legacyProfileId).toBe("anthropic:default");
    const auth = requireAuthConfig(next);
    expect(auth.profiles?.["anthropic:default"]).toBeUndefined();
    const repairedProfile = auth.profiles?.["anthropic:user@example.com"];
    expect(repairedProfile?.provider).toBe("anthropic");
    expect(repairedProfile?.mode).toBe("oauth");
    expect(repairedProfile?.email).toBe("user@example.com");
    expect(auth.order?.anthropic).toEqual(["anthropic:user@example.com"]);
  });

  it("strips provider-controlled terminal escapes from repair prompts", async () => {
    authProfileStoreMock.store = {
      version: 1,
      profiles: {
        "anthropic:user@example.com": {
          type: "oauth",
          provider: "anthropic",
          access: "token-a",
          refresh: "token-r",
          expires: Date.now() + 60_000,
          email: "user@example.com",
        },
      },
    };

    resolvePluginProvidersMock.mockReturnValue([
      {
        id: "anthropic",
        label: "\u001b[31mAnthropic\u001b[0m",
        auth: [],
        oauthProfileIdRepairs: [
          { legacyProfileId: "anthropic:default", promptLabel: "\u001b[2JBad\u0007 Label" },
        ],
      },
    ]);
    repairMocks.repairOAuthProfileIdMismatch.mockReturnValue({
      migrated: true,
      changes: ["Auth: migrate anthropic:default to anthropic:user@example.com"],
      config: { auth: { profiles: {} } },
    });

    const prompter = makePrompter(true);
    await maybeRepairLegacyOAuthProfileIds(
      {
        auth: {
          profiles: {
            "anthropic:default": { provider: "anthropic", mode: "oauth" },
          },
        },
      } as OpenClawConfig,
      prompter,
    );

    expect(prompter.confirm).toHaveBeenCalledWith({
      message: "Update Bad Label OAuth profile id in config now?",
      initialValue: true,
    });
  });
});
