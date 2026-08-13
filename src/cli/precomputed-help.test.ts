// Precomputed help tests cover the strict argv shape required by help fast paths.
import { describe, expect, it, vi } from "vitest";
import { tryOutputPrecomputedCommandHelp } from "./precomputed-help.js";

describe("tryOutputPrecomputedCommandHelp", () => {
  it("renders only an unambiguous command help request", async () => {
    const outputBrowserHelp = vi.fn(() => true);

    await expect(
      tryOutputPrecomputedCommandHelp(["node", "openclaw", "browser", "--help"], {
        outputPrecomputedBrowserHelpText: outputBrowserHelp,
        env: {},
      }),
    ).resolves.toBe(true);
    expect(outputBrowserHelp).toHaveBeenCalledOnce();
  });

  it("falls back when a command option may own --help as its value", async () => {
    const outputBrowserHelp = vi.fn(() => true);

    await expect(
      tryOutputPrecomputedCommandHelp(["node", "openclaw", "browser", "--target", "--help"], {
        outputPrecomputedBrowserHelpText: outputBrowserHelp,
        env: {},
      }),
    ).resolves.toBe(false);
    expect(outputBrowserHelp).not.toHaveBeenCalled();
  });

  it("leaves secrets apply --from --help for Commander to parse", async () => {
    const outputSecretsHelp = vi.fn(() => true);

    await expect(
      tryOutputPrecomputedCommandHelp(
        ["node", "openclaw", "secrets", "apply", "--from", "--help"],
        {
          outputPrecomputedSecretsHelpText: outputSecretsHelp,
          env: {},
        },
      ),
    ).resolves.toBe(false);
    expect(outputSecretsHelp).not.toHaveBeenCalled();
  });
});
