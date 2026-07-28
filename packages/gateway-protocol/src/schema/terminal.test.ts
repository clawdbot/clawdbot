import { describe, expect, it } from "vitest";
import { validateTerminalOpenParams, validateTerminalUploadParams } from "../index.js";
import { MAX_TERMINAL_UPLOAD_BASE64_LENGTH } from "./terminal-constants.js";

describe("terminal protocol", () => {
  it("accepts a typed catalog reference and rejects client command fields", () => {
    expect(
      validateTerminalOpenParams({
        cols: 80,
        rows: 24,
        catalog: { catalogId: "codex", hostId: "gateway:local", threadId: "thread" },
      }),
    ).toBe(true);
    expect(
      validateTerminalOpenParams({
        cols: 80,
        rows: 24,
        catalog: {
          catalogId: "codex",
          hostId: "gateway:local",
          threadId: "thread",
          argv: ["sh"],
        },
      }),
    ).toBe(false);
    expect(
      validateTerminalOpenParams({
        cols: 80,
        rows: 24,
        cwd: "/tmp",
      }),
    ).toBe(false);
  });

  it("bounds terminal uploads inside one gateway frame", () => {
    expect(
      validateTerminalUploadParams({
        sessionId: "terminal-1",
        name: "scan.pdf",
        contentBase64: "AA==",
      }),
    ).toBe(true);
    expect(
      validateTerminalUploadParams({
        sessionId: "terminal-1",
        name: "scan.pdf",
        contentBase64: "A".repeat(MAX_TERMINAL_UPLOAD_BASE64_LENGTH + 1),
      }),
    ).toBe(false);
    expect(
      validateTerminalUploadParams({
        sessionId: "terminal-1",
        name: "scan.pdf",
        contentBase64: "AA==",
        destination: "/etc",
      }),
    ).toBe(false);
  });
});
