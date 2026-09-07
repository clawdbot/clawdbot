/** Model-facing description contracts at the public Bash/process tool factory boundary. */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as execApprovals from "../infra/exec-approvals.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { finalizeAgentTools } from "./agent-tools.finalize.js";
import { createExecTool, createProcessTool } from "./bash-tools.js";
import { createLazyExecTool } from "./lazy-exec-tool.js";

const execDefaults = { host: "gateway", security: "full", ask: "off" } as const;
const execTool = createExecTool(execDefaults);
const processTool = createProcessTool();

afterEach(() => vi.restoreAllMocks());

describe("tool descriptions", () => {
  it.each(["win32", "linux", "darwin"] as const)(
    "keeps exec descriptors stable across approval changes on %s",
    (platform) =>
      withMockedPlatform(platform, () => {
        const file: execApprovals.ExecApprovalsFile = {
          version: 1,
          agents: { main: { allowlist: [] } },
        };
        vi.spyOn(execApprovals, "loadExecApprovals").mockImplementation(() => file);
        const descriptors = () => {
          const tools = [
            createExecTool({ ...execDefaults, agentId: "main" }),
            createLazyExecTool({ ...execDefaults, agentId: "main" }),
          ];
          return JSON.stringify(
            [
              ...tools,
              ...tools.flatMap((tool) =>
                finalizeAgentTools({
                  tools: [tool],
                  hookContext: {},
                  wrapBeforeToolCallHook: false,
                }),
              ),
            ].map(({ name, description, parameters }) => ({ name, description, parameters })),
          );
        };
        const before = descriptors();
        file.agents!.main!.allowlist!.push({
          pattern: "C:\\Tools\\node.exe",
          argPattern: "--version",
        });
        expect(descriptors()).toBe(before);
      }),
  );
  it("adds automation follow-up guidance only when the scheduler is available", () => {
    const execWithCron = createExecTool({ ...execDefaults, hasCronTool: true });
    const processWithCron = createProcessTool({ hasCronTool: true });

    expect(execWithCron.description).toContain(
      "automatic completion wake when enabled and output/failure occurs; otherwise process confirms completion",
    );
    expect(processWithCron.description).toContain("completion without auto-wake");
    expect(processWithCron.description).toContain("write, send-keys, submit, paste, kill");
    expect(execWithCron.description).toContain(
      "No sleep loops for reminders/follow-ups; use automations.",
    );
    expect(processWithCron.description).toContain(
      "No polling as timer/reminder; scheduled follow-up uses automations.",
    );
    expect(execTool.description).not.toContain("use cron instead");
    expect(processTool.description).not.toContain("scheduled follow-ups");
    expect(execTool.description).toContain("otherwise process confirms completion");
    expect(processTool.description).toContain("completion without auto-wake");
    expect(processTool.description).toContain("write, send-keys, submit, paste, kill");
  });

  it.each(["darwin", "linux", "win32"] as const)(
    "limits shell-quoting guidance to Unix hosts: %s",
    (platform) => {
      withMockedPlatform(platform, () => {
        expect(
          execTool.description.includes(
            "Quote arguments containing shell metacharacters, including URL query strings with `?` or `&`.",
          ),
        ).toBe(platform !== "win32");
      });
    },
  );
});
