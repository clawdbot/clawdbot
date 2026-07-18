import { describe, expect, it } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { adaptCodexTestClientFactory } from "./test-support.js";

describe("adaptCodexTestClientFactory", () => {
  it("adds stable distinct identities to narrow client doubles", async () => {
    const clients = [{}, {}] as unknown as [CodexAppServerClient, CodexAppServerClient];
    let index = 0;
    const factory = adaptCodexTestClientFactory(async () => clients[Math.min(index++, 1)]!);

    const first = await factory();
    index = 0;
    const firstAgain = await factory();
    index = 1;
    const second = await factory();

    expect(firstAgain).toBe(first);
    expect(firstAgain.getInstanceId()).toBe(first.getInstanceId());
    expect(second.getInstanceId()).not.toBe(first.getInstanceId());
  });
});
