/** Exercises text directive policy and prompt handling through the complete reply pipeline. */
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
    payloads: [{ text: "The output is ready." }],
    meta: { durationMs: 1 },
  })),
}));

let state: OpenClawTestState | undefined;
afterEach(async () => {
  await state?.cleanup();
  vi.clearAllMocks();
});

it.each([" ", "\n"])("runs a task after text exec policy separated by %j", async (separator) => {
  state = await createOpenClawTestState({
    label: "text-directive-reply",
    env: { OPENCLAW_TEST_FAST: "0" },
  });
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
  const body = `/exec security=deny ask=always${separator}Explain the output.`;
  const reply = await getReplyFromConfig(
    finalizeInboundContext({
      Body: body,
      RawBody: body,
      BodyForAgent: body,
      CommandBody: body,
      CommandSource: "text",
      CommandAuthorized: true,
      Provider: "webchat",
      Surface: "webchat",
      ChatType: "direct",
      SessionKey: "agent:main:text-directive-proof",
    }),
    undefined,
    cfg,
  );

  expect([reply].flat()).toEqual([expect.objectContaining({ text: "The output is ready." })]);
  expect(runEmbeddedAgent).toHaveBeenCalledOnce();
  const input = vi.mocked(runEmbeddedAgent).mock.calls[0]![0];
  expect(input.prompt).toContain("Explain the output.");
  expect(input.prompt).not.toContain("/exec");
  expect(input.execOverrides).toMatchObject({ security: "deny", ask: "always" });
});
