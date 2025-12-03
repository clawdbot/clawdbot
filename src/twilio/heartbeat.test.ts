import { describe, expect, it, vi } from "vitest";

import { HEARTBEAT_TOKEN } from "../web/auto-reply.js";
import { runTwilioHeartbeatOnce } from "./heartbeat.js";

vi.mock("./send.js", () => ({
  sendMessage: vi.fn(),
}));

vi.mock("../auto-reply/reply.js", () => ({
  getReplyFromConfig: vi.fn(),
}));

// eslint-disable-next-line import/first
import { getReplyFromConfig } from "../auto-reply/reply.js";
// eslint-disable-next-line import/first
import { sendMessage } from "./send.js";

const sendMessageMock = sendMessage as unknown as vi.Mock;
const replyResolverMock = getReplyFromConfig as unknown as vi.Mock;

describe("runTwilioHeartbeatOnce", () => {
  it("sends manual override body and skips resolver", async () => {
    sendMessageMock.mockResolvedValue({});
    await runTwilioHeartbeatOnce({
      to: "+1555",
      overrideBody: "hello manual",
    });
    expect(sendMessage).toHaveBeenCalledWith(
      "+1555",
      "hello manual",
      undefined,
      expect.anything(),
    );
    expect(replyResolverMock).not.toHaveBeenCalled();
  });

  it("dry-run manual message avoids sending", async () => {
    sendMessageMock.mockReset();
    await runTwilioHeartbeatOnce({
      to: "+1555",
      overrideBody: "hello manual",
      dryRun: true,
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(replyResolverMock).not.toHaveBeenCalled();
  });

  it("skips send when resolver returns heartbeat token", async () => {
    replyResolverMock.mockResolvedValue({
      text: HEARTBEAT_TOKEN,
    });
    sendMessageMock.mockReset();
    await runTwilioHeartbeatOnce({
      to: "+1555",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("sends resolved heartbeat text when present", async () => {
    replyResolverMock.mockResolvedValue({
      text: "ALERT!",
    });
    sendMessageMock.mockReset().mockResolvedValue({});
    await runTwilioHeartbeatOnce({
      to: "+1555",
    });
    expect(sendMessage).toHaveBeenCalledWith(
      "+1555",
      "ALERT!",
      undefined,
      expect.anything(),
    );
  });
});
