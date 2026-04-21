import { installChannelOutboundPayloadContractSuite } from "openclaw/plugin-sdk/testing";
import { describe } from "vitest";
import { createSlackOutboundPayloadHarness } from "./outbound-payload.test-harness.js";

describe("Slack outbound payload contract", () => {
  installChannelOutboundPayloadContractSuite({
    channel: "slack",
    chunking: { mode: "passthrough", longTextLength: 5000 },
    createHarness: createSlackOutboundPayloadHarness,
  });
});
