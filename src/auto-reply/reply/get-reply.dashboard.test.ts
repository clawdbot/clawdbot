import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { getReplyFromConfig } from "./get-reply.js";
import { finalizeInboundContext } from "./inbound-context.js";

vi.mock("../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/embedded-agent.js")>()),
  runEmbeddedAgent: vi.fn(async () => ({
    payloads: [{ text: "Dashboard prepared" }],
    meta: { durationMs: 1 },
  })),
}));

let state: OpenClawTestState | undefined;
afterEach(async () => {
  await state?.cleanup();
  vi.clearAllMocks();
});

it.each([
  { source: "text", authorized: true },
  { source: "native", authorized: true },
  { source: "native", authorized: false },
] as const)(
  "preserves dashboard skill ownership for $source with authorized=$authorized",
  async ({ source, authorized }) => {
    state = await createOpenClawTestState({
      label: "dashboard-reply",
      env: { OPENCLAW_TEST_FAST: "0" },
    });
    const skillDir = path.join(state.workspaceDir, "skills", "control-ui");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: control-ui\ndescription: Workspace dashboard skill collision.\n---\nWorkspace-specific instructions.\n",
    );
    const cfg = withFullRuntimeReplyConfig({
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          skipBootstrap: true,
          model: { primary: "mock-openai/gpt-5.6-luna" },
          models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
        },
      },
      plugins: { enabled: false },
      commands: { text: true },
    });
    await state.writeConfig(cfg);
    const body = "/dashboard release health";
    const sessionKey = "agent:main:dashboard-proof";
    const reply = await getReplyFromConfig(
      finalizeInboundContext({
        Body: body,
        RawBody: body,
        BodyForAgent: body,
        CommandBody: body,
        CommandSource: source,
        CommandAuthorized: authorized,
        Provider: "webchat",
        Surface: "webchat",
        ChatType: "direct",
        SessionKey: sessionKey,
        ...(source === "native" ? { CommandTargetSessionKey: sessionKey } : {}),
      }),
      undefined,
      cfg,
    );
    if (!authorized) {
      expect([reply].flat()).toEqual([
        expect.objectContaining({ text: "You are not authorized to use this command." }),
      ]);
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
      return;
    }
    expect([reply].flat()).toEqual([expect.objectContaining({ text: "Dashboard prepared" })]);
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    const input = vi.mocked(runEmbeddedAgent).mock.calls[0]![0];
    expect(input.explicitSkillSelections).toEqual([
      { name: "control_ui", path: path.resolve("skills/control-ui/SKILL.md") },
    ]);
    expect(input.prompt).toContain("release health");
    expect(input.prompt.match(/Use the following explicitly referenced skills/gu)).toHaveLength(1);
  },
);
