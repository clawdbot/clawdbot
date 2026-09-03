// Regression: agent-end side effects must never mint skill proposals directly from
// chat text. Autonomous proposals may only be authored by the isolated experience
// reviewer. The deleted regex capture path turned raw user messages such as
// "That's wrong — not the 12–34k figure I told you." into live proposals named
// after slugified message fragments ("12-34k-figure-told").
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { listSkillProposals } from "../../skills/workshop/service.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { awaitAgentEndSideEffects } from "./agent-end-side-effects.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;
let sessionKeyIndex = 0;

beforeAll(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-no-verbatim-capture-",
  });
});

beforeEach(() => {
  testState.applyEnv();
});

afterEach(async () => {
  await tempDirs.cleanup();
});

afterAll(async () => {
  await testState.cleanup();
});

const CONFIG = {
  skills: {
    workshop: {
      autonomous: {
        mode: "propose" as const,
      },
    },
  },
};

async function runAgentEndTurn(workspaceDir: string, sessionKey: string, userText: string) {
  await awaitAgentEndSideEffects({
    event: {
      success: true,
      messages: [{ role: "user", content: userText }],
    },
    ctx: {
      workspaceDir,
      agentId: "main",
      sessionKey,
      trigger: "user",
      skillWorkshopAvailable: true,
      config: CONFIG,
    },
  });
}

describe("agent-end proposal provenance", () => {
  it.each([
    "That's wrong — not the 12–34k figure I told you.",
    "From now on, when working on GitHub PRs, always check CI before final response.",
    "#4242 Vendor Blue 7: Also when reading comments make sure to read the comments they responded to also.",
  ])("creates no proposal from chat text without a model review: %s", async (userText) => {
    const sessionKey = `agent:main:no-verbatim-capture-${String(++sessionKeyIndex)}`;
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId: `session-${sessionKey}`, updatedAt: 1 },
    );
    const workspaceDir = await tempDirs.make("openclaw-no-verbatim-capture-");

    await runAgentEndTurn(workspaceDir, sessionKey, userText);

    const manifest = await listSkillProposals({ workspaceDir });
    expect(manifest.proposals).toEqual([]);
  });
});
