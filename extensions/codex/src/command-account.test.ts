import { describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-runtime")>()),
  ensureAuthProfileStore: authMocks.ensureAuthProfileStore,
}));

import { readCodexAccountAuthOverview } from "./command-account.js";

describe("Codex account workspace identity", () => {
  it("attributes a shared-email ChatGPT account to its active workspace", async () => {
    authMocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "openai:personal": {
          type: "oauth",
          provider: "openai",
          access: "personal-access",
          refresh: "personal-refresh",
          expires: Date.now() + 60_000,
          email: "operator@example.test",
          accountId: "workspace-personal",
          displayName: "Personal",
        },
        "openai:work": {
          type: "oauth",
          provider: "openai",
          access: "work-access",
          refresh: "work-refresh",
          expires: Date.now() + 60_000,
          email: "operator@example.test",
          accountId: "workspace-work",
          displayName: "Work",
        },
      },
      order: { openai: ["openai:personal", "openai:work"] },
      lastGood: { openai: "openai:work" },
    });
    const safeCodexControlRequest = vi.fn();

    const overview = await readCodexAccountAuthOverview({
      ctx: { config: {} } as never,
      agentDir: "/tmp/openclaw-agent",
      pluginConfig: {},
      safeCodexControlRequest,
      account: {
        ok: true,
        value: {
          account: { type: "chatgpt", email: "operator@example.test" },
        },
      },
      limits: { ok: true, value: {} },
    });

    expect(overview?.rows.find((row) => row.active)).toMatchObject({
      profileId: "openai:work",
      label: "Work",
    });
    expect(overview?.subscriptionLabel).toBe("Work");
    expect(safeCodexControlRequest).not.toHaveBeenCalled();
  });
});
