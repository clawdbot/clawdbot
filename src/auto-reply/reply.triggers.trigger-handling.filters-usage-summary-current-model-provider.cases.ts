/** Shared cases for filtering usage summaries by current model/provider. */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getProviderUsageMocks,
  getRunEmbeddedAgentMock,
  makeCfg,
  requireSessionStorePath,
  withTempHome,
} from "../../test/helpers/auto-reply/trigger-handling-test-harness.js";
import { listSessionEntries } from "../config/sessions/session-accessor.js";

type GetReplyFromConfig = typeof import("./reply.js").getReplyFromConfig;

const usageMocks = getProviderUsageMocks();

function getReplyFromConfigNow(getReplyFromConfig: () => GetReplyFromConfig): GetReplyFromConfig {
  return getReplyFromConfig();
}

function replyText(reply: Awaited<ReturnType<GetReplyFromConfig>>): string {
  return (Array.isArray(reply) ? reply[0]?.text : reply?.text) ?? "";
}

function seedUsageSummary(): void {
  usageMocks.loadProviderUsageSummary.mockClear();
  usageMocks.loadProviderUsageSummary.mockResolvedValue({
    updatedAt: 0,
    providers: [
      {
        provider: "anthropic",
        displayName: "Anthropic",
        windows: [
          {
            label: "5h",
            usedPercent: 20,
          },
        ],
      },
    ],
  });
}

export function registerTriggerHandlingUsageSummaryCases(params: {
  getReplyFromConfig: () => GetReplyFromConfig;
}): void {
  describe("usage and status command handling", () => {
    it("shows status without invoking the agent", async () => {
      await withTempHome(async (home) => {
        const runEmbeddedAgentMock = getRunEmbeddedAgentMock();
        const getReplyFromConfig = getReplyFromConfigNow(params.getReplyFromConfig);
        seedUsageSummary();

        const res = await getReplyFromConfig(
          {
            Body: "/status",
            From: "+1000",
            To: "+2000",
            Provider: "whatsapp",
            SenderE164: "+1000",
            CommandAuthorized: true,
          },
          {},
          makeCfg(home),
        );

        const text = Array.isArray(res) ? res[0]?.text : res?.text;
        expect(text).toContain("Model:");
        expect(text).toContain("OpenClaw");
        expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
      });
    });

    it("cycles usage footer modes and persists the final selection", async () => {
      await withTempHome(async (home) => {
        const runEmbeddedAgentMock = getRunEmbeddedAgentMock();
        const getReplyFromConfig = getReplyFromConfigNow(params.getReplyFromConfig);
        const cfg = makeCfg(home);
        cfg.session = { ...cfg.session, store: join(home, "usage-cycle.sessions.json") };
        const usageStorePath = requireSessionStorePath(cfg);

        const r0 = await getReplyFromConfig(
          {
            Body: "/usage on",
            From: "+1000",
            To: "+2000",
            Provider: "whatsapp",
            SenderE164: "+1000",
            CommandAuthorized: true,
          },
          undefined,
          cfg,
        );
        expect(replyText(r0)).toContain("Usage footer: tokens");

        const r1 = await getReplyFromConfig(
          {
            Body: "/usage",
            From: "+1000",
            To: "+2000",
            Provider: "whatsapp",
            SenderE164: "+1000",
            CommandAuthorized: true,
          },
          undefined,
          cfg,
        );
        expect(replyText(r1)).toContain("Usage footer: full");

        const r2 = await getReplyFromConfig(
          {
            Body: "/usage",
            From: "+1000",
            To: "+2000",
            Provider: "whatsapp",
            SenderE164: "+1000",
            CommandAuthorized: true,
          },
          undefined,
          cfg,
        );
        expect(replyText(r2)).toContain("Usage footer: off");

        const r3 = await getReplyFromConfig(
          {
            Body: "/usage",
            From: "+1000",
            To: "+2000",
            Provider: "whatsapp",
            SenderE164: "+1000",
            CommandAuthorized: true,
          },
          undefined,
          cfg,
        );
        expect(replyText(r3)).toContain("Usage footer: tokens");

        const finalEntries = listSessionEntries({ storePath: usageStorePath });
        expect(finalEntries[0]?.entry.responseUsage).toBe("tokens");
        expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
      });
    });
  });
}
