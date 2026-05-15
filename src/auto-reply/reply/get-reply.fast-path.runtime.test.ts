import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  createReplyRuntimeMocks,
  createTempHomeHarness,
  installReplyRuntimeMocks,
  makeEmbeddedTextResult,
  makeReplyConfig,
  resetReplyRuntimeMocks,
} from "../reply.test-harness.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;
const agentMocks = createReplyRuntimeMocks();
const { withTempHome } = createTempHomeHarness({ prefix: "openclaw-getreply-fast-" });

installReplyRuntimeMocks(agentMocks);

describe("getReplyFromConfig fast-path runtime", () => {
  beforeEach(async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    resetReplyRuntimeMocks(agentMocks);
    ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("keeps old-style runtime tests fast with marked temp-home configs", async () => {
    await withTempHome(async (home) => {
      let seenPrompt: string | undefined;
      agentMocks.runEmbeddedPiAgent.mockImplementation(async (params) => {
        seenPrompt = params.prompt;
        return makeEmbeddedTextResult("ok");
      });

      const res = await getReplyFromConfig(
        {
          Body: "hello",
          BodyForAgent: "hello",
          RawBody: "hello",
          CommandBody: "hello",
          From: "+1001",
          To: "+2000",
          MediaPaths: ["/tmp/a.png", "/tmp/b.png"],
          MediaUrls: ["/tmp/a.png", "/tmp/b.png"],
          SessionKey: "agent:main:whatsapp:+2000",
          Provider: "whatsapp",
          Surface: "whatsapp",
          ChatType: "direct",
        },
        {},
        makeReplyConfig(home) as OpenClawConfig,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("ok");
      expect(seenPrompt).toContain("[media attached: 2 files]");
      expect(seenPrompt).toContain("hello");
    });
  });

  it("routes structured native command turns through the target session before legacy sync", async () => {
    await withTempHome(async (home) => {
      agentMocks.runEmbeddedPiAgent.mockResolvedValue(makeEmbeddedTextResult("ok"));

      await getReplyFromConfig(
        {
          Body: "hello",
          BodyForAgent: "hello",
          RawBody: "hello",
          CommandBody: "hello",
          CommandTurn: {
            kind: "native",
            source: "native",
            authorized: true,
          },
          CommandTargetSessionKey: "agent:main:telegram:direct:target",
          SessionKey: "telegram:slash:source",
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "direct",
        },
        {},
        makeReplyConfig(home) as OpenClawConfig,
      );

      expect(agentMocks.runEmbeddedPiAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:telegram:direct:target",
        }),
      );
    });
  });

  it("ignores stale native legacy source for structured normal turns before routing", async () => {
    await withTempHome(async (home) => {
      agentMocks.runEmbeddedPiAgent.mockResolvedValue(makeEmbeddedTextResult("ok"));

      await getReplyFromConfig(
        {
          Body: "hello",
          BodyForAgent: "hello",
          RawBody: "hello",
          CommandBody: "hello",
          CommandSource: "native",
          CommandTurn: {
            kind: "normal",
            source: "message",
            authorized: false,
          },
          CommandTargetSessionKey: "agent:main:telegram:direct:stale-target",
          SessionKey: "agent:main:telegram:direct:source",
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "direct",
        },
        {},
        makeReplyConfig(home) as OpenClawConfig,
      );

      expect(agentMocks.runEmbeddedPiAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:telegram:direct:source",
        }),
      );
    });
  });
});
