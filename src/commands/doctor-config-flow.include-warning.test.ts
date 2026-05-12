import { describe, expect, it, vi } from "vitest";
import { note } from "../terminal/note.js";
import { noteIncludeConfinementWarning } from "./doctor-config-analysis.js";

vi.mock("../terminal/note.js", () => ({
  note: vi.fn(),
}));

const noteSpy = vi.mocked(note);

describe("doctor include warning", () => {
  it("surfaces include confinement hint for escaped include paths", () => {
    noteIncludeConfinementWarning({
      path: "/tmp/openclaw-config/openclaw.json",
      issues: [
        {
          message: "Include path escapes config directory: /etc/passwd",
        },
      ],
    });

    expect(noteSpy).toHaveBeenCalledWith(
      [
        "- $include paths must stay under: /tmp/openclaw-config",
        '- Move shared include files under that directory and update to relative paths like "./shared/common.json".',
        "- Error: Include path escapes config directory: /etc/passwd",
      ].join("\n"),
      "Doctor warnings",
    );
  });
});
