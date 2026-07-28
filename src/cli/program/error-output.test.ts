// Error output tests cover program-level error display and exit messaging.
import { describe, expect, it } from "vitest";
import { formatCliParseErrorOutput } from "./error-output.js";

describe("formatCliParseErrorOutput", () => {
  it("explains unknown commands with root help and plugin hints", () => {
    const output = formatCliParseErrorOutput("error: unknown command 'wat'\n", {
      argv: ["node", "openclaw", "wat"],
    });

    expect(output).toBe(
      'OpenClaw does not know the command "wat".\nTry: openclaw --help\nPlugin command? openclaw plugins list\nDocs: https://docs.openclaw.ai/cli\n',
    );
  });

  it("suggests close known commands for unknown commands", () => {
    const output = formatCliParseErrorOutput("error: unknown command 'upate'\n", {
      argv: ["node", "openclaw", "upate"],
    });

    expect(output).toBe(
      'OpenClaw does not know the command "upate".\nDid you mean this?\n  openclaw update\nTry: openclaw --help\nPlugin command? openclaw plugins list\nDocs: https://docs.openclaw.ai/cli\n',
    );
  });

  it("suggests explicit aliases for common adjacent terminology", () => {
    const output = formatCliParseErrorOutput("error: unknown command 'upgrade'\n", {
      argv: ["node", "openclaw", "upgrade"],
    });

    expect(output).toContain("Did you mean this?\n  openclaw update\n");
  });

  it("preserves active profile context in command suggestions", () => {
    const originalProfile = process.env.OPENCLAW_PROFILE;
    process.env.OPENCLAW_PROFILE = "work";
    try {
      const output = formatCliParseErrorOutput("error: unknown command 'doctr'\n", {
        argv: ["node", "openclaw", "doctr"],
      });

      expect(output).toContain("Did you mean this?\n  openclaw --profile work doctor\n");
    } finally {
      if (originalProfile === undefined) {
        delete process.env.OPENCLAW_PROFILE;
      } else {
        process.env.OPENCLAW_PROFILE = originalProfile;
      }
    }
  });

  it("points unknown options at the active command help", () => {
    const output = formatCliParseErrorOutput("error: unknown option '--wat'\n", {
      argv: ["node", "openclaw", "channels", "status", "--wat"],
    });

    expect(output).toBe(
      'OpenClaw does not recognize option "--wat".\nTry: openclaw channels status --help\n',
    );
  });

  it("points missing required arguments at command help", () => {
    const output = formatCliParseErrorOutput("error: missing required argument 'name'\n", {
      argv: ["node", "openclaw", "plugins", "install"],
    });

    expect(output).toBe(
      'Missing required argument "name".\nTry: openclaw plugins install --help\n',
    );
  });
});
