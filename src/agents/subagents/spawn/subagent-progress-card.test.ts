import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { appendProgressCardSystemPrompt } from "../../progress-card-system-prompt.js";
import { resolveEffectiveToolInventory } from "../../tools-effective-inventory.js";

vi.mock("../../../infra/device-pairing.js", () => ({
  hasPairedCardRenderer: async () => true,
}));

describe("subagent progress-card availability", () => {
  let tempDir: string;
  let config: OpenClawConfig;
  const parent = "agent:main:dashboard:parent";
  const children = [
    "agent:main:subagent:orchestrator",
    "agent:main:subagent:leaf",
    "agent:main:dashboard:child",
    "agent:main:acp:child",
  ];

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-child-progress-"));
    const store = path.join(tempDir, "sessions.json");
    config = {
      session: { store },
      plugins: { enabled: false },
      tools: {
        allow: ["read", "progress_card"],
        subagents: { tools: { allow: ["read", "progress_card"], alsoAllow: ["update_plan"] } },
      },
    };
    for (const sessionKey of children) {
      await replaceSessionEntry(
        { storePath: store, sessionKey },
        {
          sessionId: sessionKey.split(":").slice(2).join("-"),
          updatedAt: Date.now(),
          spawnedBy: parent,
          spawnDepth: sessionKey.endsWith(":leaf") ? 5 : 1,
          subagentRole: sessionKey.endsWith(":leaf") ? "leaf" : "orchestrator",
          inheritedToolPolicyVersion: 1,
          inheritedToolAllow: ["read", "progress_card"],
        },
      );
    }
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it.each([parent, ...children])("exposes tools and guidance for %s", async (sessionKey) => {
    const inventory = resolveEffectiveToolInventory({
      cfg: config,
      sessionKey,
      workspaceDir: tempDir,
      agentDir: tempDir,
      modelApi: null,
    });
    const names = inventory.groups.flatMap((group) => group.tools.map((tool) => tool.id));
    expect(names).toContain("read");
    expect(names.includes("progress_card")).toBe(sessionKey === parent);
    const prompt = await appendProgressCardSystemPrompt({
      agentId: "main",
      config,
      sessionKey,
      modelId: "model",
      provider: "mock",
      extraSystemPrompt: "Work on the assigned task.",
    });
    expect(prompt?.includes("progress_card")).toBe(sessionKey === parent);
    expect(prompt).toContain("Work on the assigned task.");
    for (const tool of inventory.groups.flatMap((group) => group.tools)) {
      if (sessionKey !== parent) {
        expect(tool.description).not.toContain("progress_card");
      }
    }
  });
});
