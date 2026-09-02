// Handshake coverage for the additive chat-attachment limits on `hello-ok`, so
// clients can validate a file before sending instead of hardcoding guesses.
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

type GatewayHarness = Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
let gateway: GatewayHarness;

type HelloPolicy = {
  policy?: { attachments?: { maxBytes?: number; maxImageBytes?: number } };
};

async function readAdvertisedAttachments(mediaMaxMb: number): Promise<unknown> {
  testState.agentConfig = { mediaMaxMb };
  // The handshake reads the pinned runtime snapshot, so drop it to pick the
  // override up on the next connection.
  clearConfigCache();
  clearRuntimeConfigSnapshot();
  const socket = await gateway.openWs();
  try {
    const hello = (await connectOk(socket)) as HelloPolicy;
    return hello.policy?.attachments;
  } finally {
    socket.close();
  }
}

describe("hello-ok attachment limits", () => {
  beforeAll(async () => {
    gateway = await createGatewaySuiteHarness();
  });

  afterAll(async () => {
    await gateway.close();
    testState.agentConfig = undefined;
    clearConfigCache();
    clearRuntimeConfigSnapshot();
  });

  test("advertises the configured ceiling and the image hydration cap", async () => {
    expect(await readAdvertisedAttachments(7)).toEqual({
      maxBytes: 7 * 1024 * 1024,
      maxImageBytes: MAX_IMAGE_BYTES,
    });
  });

  test("clamps the advertised image ceiling to a smaller configured ceiling", async () => {
    expect(await readAdvertisedAttachments(2)).toEqual({
      maxBytes: 2 * 1024 * 1024,
      maxImageBytes: 2 * 1024 * 1024,
    });
  });
});
