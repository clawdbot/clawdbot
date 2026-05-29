import process from "node:process";
import { describe, expect, it } from "vitest";
import { appendBoundedProcessOutput, runProcess } from "../../scripts/control-ui-i18n.ts";

describe("control-ui-i18n process runner", () => {
  it("keeps a bounded process output tail", () => {
    const first = appendBoundedProcessOutput({ text: "", truncatedChars: 0 }, "abcdef", 5);
    const second = appendBoundedProcessOutput(first, "ghij", 5);

    expect(first).toEqual({ text: "bcdef", truncatedChars: 1 });
    expect(second).toEqual({ text: "fghij", truncatedChars: 5 });
  });

  it("bounds failure diagnostics to the newest output", async () => {
    await expect(
      runProcess(
        process.execPath,
        [
          "-e",
          [
            "process.stderr.write('stderr-begin-' + 'x'.repeat(128) + '-stderr-end', () => process.exit(2));",
          ].join(" "),
        ],
        { maxOutputChars: 64, rejectOnFailure: true },
      ),
    ).rejects.toThrow(/output truncated[\s\S]*stderr-end/u);
  });

  it("rejects successful commands before returning truncated stdout", async () => {
    await expect(
      runProcess(
        process.execPath,
        ["-e", "process.stdout.write('x'.repeat(128), () => process.exit(0));"],
        {
          maxOutputChars: 12,
        },
      ),
    ).rejects.toThrow("produced more than 12 stdout chars");
  });
});
