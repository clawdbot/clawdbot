// QA Lab WhatsApp tests cover CLI delegation into the shared suite host.
import { beforeEach, describe, expect, it, vi } from "vitest";

const runQaSuiteCommand = vi.hoisted(() => vi.fn());

vi.mock("../../cli.runtime.js", () => ({ runQaSuiteCommand }));
vi.mock("../shared/live-transport-cli.runtime.js", () => ({
  resolveLiveTransportQaRunOptions: (opts: Record<string, unknown>) => ({
    ...opts,
    repoRoot: "/resolved-repo",
    outputDir: "/resolved-repo/.artifacts/resolved",
    providerMode: opts.providerMode ?? "live-frontier",
  }),
}));

import { runQaWhatsAppCommand } from "./cli.runtime.js";
import { resolveWhatsAppQaScenarioIds } from "./profiles.js";

describe("QA Lab WhatsApp CLI runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates the live profile into the WhatsApp adapter host", async () => {
    await runQaWhatsAppCommand({
      repoRoot: "/repo",
      outputDir: ".artifacts/whatsapp",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.5",
      alternateModel: "openai/gpt-5.5-alt",
      fastMode: true,
      allowFailures: true,
      failFast: true,
      credentialSource: "convex",
      credentialRole: "ci",
      sutAccountId: "whatsapp-sut",
    });

    expect(runQaSuiteCommand).toHaveBeenCalledWith({
      repoRoot: "/repo",
      outputDir: ".artifacts/whatsapp",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.5",
      alternateModel: "openai/gpt-5.5-alt",
      fastMode: true,
      allowFailures: true,
      failFast: true,
      channelDriver: "live",
      channel: "whatsapp",
      concurrency: 1,
      scenarioIds: resolveWhatsAppQaScenarioIds({ providerMode: "live-frontier" }),
      sutAccountId: "whatsapp-sut",
      credentialSource: "convex",
      credentialRole: "ci",
      explicitScenarioSelection: false,
    });
  });

  it("lets explicit scenarios override profile selection", async () => {
    await runQaWhatsAppCommand({ scenarioIds: ["whatsapp-help-command"] });

    expect(runQaSuiteCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        explicitScenarioSelection: true,
        scenarioIds: ["whatsapp-help-command"],
      }),
    );
  });
});
