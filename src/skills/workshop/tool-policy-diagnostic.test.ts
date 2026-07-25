import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { detectSkillWorkshopToolPolicyDiagnostic } from "./tool-policy-diagnostic.js";

function detect(config: OpenClawConfig, workshopEnabled = true) {
  const agents = config.agents;
  const hasRoster = Boolean(agents && ("entries" in agents || "list" in agents));
  return detectSkillWorkshopToolPolicyDiagnostic({
    config: {
      ...config,
      agents: hasRoster ? agents : { ...agents, entries: { main: { default: true } } },
    },
    workshopEnabled,
  });
}

describe("detectSkillWorkshopToolPolicyDiagnostic", () => {
  it("names the profile and exact additive grant when policy excludes the tool", () => {
    expect(detect({ tools: { profile: "messaging" } })).toMatchObject({
      source: "tools.profile",
      detail: 'tools.profile: "messaging" does not include "skill_workshop".',
      fix: 'Add tools.alsoAllow: ["skill_workshop"].',
    });
  });

  it("returns no diagnostic when policy includes the tool", () => {
    expect(detect({ tools: { profile: "coding" } })).toBeNull();
    expect(detect({ tools: { profile: "messaging", alsoAllow: ["skill_workshop"] } })).toBeNull();
  });

  it("returns no diagnostic when Workshop capture is disabled", () => {
    expect(detect({ tools: { profile: "messaging" } }, false)).toBeNull();
  });

  it("names a restrictive allowlist that excludes the tool", () => {
    expect(detect({ tools: { profile: "coding", allow: ["read", "write"] } })).toMatchObject({
      source: "tools.allow",
      detail: 'tools.allow does not include "skill_workshop".',
      fix: 'Add "skill_workshop" to tools.allow.',
    });
  });

  it("names agent-scoped profile and allowlist sources", () => {
    expect(
      detect({
        agents: { list: [{ id: "main", default: true, tools: { profile: "messaging" } }] },
      }),
    ).toMatchObject({
      source: "agents.list[0].tools.profile",
      fix: 'Add agents.list[0].tools.alsoAllow: ["skill_workshop"].',
    });

    expect(
      detect({
        agents: { list: [{ id: "main", default: true, tools: { allow: ["read"] } }] },
      }),
    ).toMatchObject({
      source: "agents.list[0].tools.allow",
      fix: 'Add "skill_workshop" to agents.list[0].tools.allow.',
    });
  });

  it("targets the effective agent-scoped profile grant owner", () => {
    expect(
      detect({
        tools: { profile: "messaging" },
        agents: { list: [{ id: "main", default: true, tools: { alsoAllow: ["read"] } }] },
      }),
    ).toMatchObject({
      source: "tools.profile",
      fix: 'Add agents.list[0].tools.alsoAllow: ["skill_workshop"].',
    });
  });

  it("names the matching provider profile source", () => {
    expect(
      detect({
        agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
        tools: { byProvider: { openai: { profile: "messaging" } } },
      }),
    ).toMatchObject({
      source: 'tools.byProvider["openai"].profile',
      fix: 'Add tools.byProvider["openai"].alsoAllow: ["skill_workshop"].',
    });
  });

  it("targets the effective agent-scoped provider profile grant owner", () => {
    expect(
      detect({
        agents: {
          defaults: { model: { primary: "openai/gpt-5.5" } },
          list: [
            {
              id: "main",
              default: true,
              tools: { byProvider: { openai: { alsoAllow: ["read"] } } },
            },
          ],
        },
        tools: { byProvider: { openai: { profile: "messaging" } } },
      }),
    ).toMatchObject({
      source: 'tools.byProvider["openai"].profile',
      fix: 'Add agents.list[0].tools.byProvider["openai"].alsoAllow: ["skill_workshop"].',
    });
  });

  it("names the matching agent provider allowlist source", () => {
    expect(
      detect({
        agents: {
          defaults: { model: { primary: "openai/gpt-5.5" } },
          list: [
            {
              id: "main",
              default: true,
              tools: { byProvider: { openai: { allow: ["read"] } } },
            },
          ],
        },
      }),
    ).toMatchObject({
      source: 'agents.list[0].tools.byProvider["openai"].allow',
      fix: 'Add "skill_workshop" to agents.list[0].tools.byProvider["openai"].allow.',
    });
  });

  it("names an explicit deny and its removal", () => {
    expect(detect({ tools: { deny: ["skill_workshop"] } })).toMatchObject({
      source: "tools.deny",
      detail: 'tools.deny denies "skill_workshop".',
      fix: 'Remove the matching "skill_workshop" deny entry from tools.deny.',
    });
  });
});
