/** Model-facing description contracts at the public Bash/process tool factory boundary. */
import { describe, expect, it } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { createExecTool, createProcessTool } from "./bash-tools.js";

const execDefaults = { host: "gateway", security: "full", ask: "off" } as const;
const execTool = createExecTool(execDefaults);
const processTool = createProcessTool();

describe("tool descriptions", () => {
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
