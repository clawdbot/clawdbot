import { describe, expect, it } from "vitest";
import { createCrablineProviderDelivery } from "./crabline-provider-targets.js";

describe("Crabline provider target translation", () => {
  it.each([
    {
      source: "thread:/v1/dm/Alice/Topic",
      translated: "thread:/v1/dm/!3bc51062973c458d:matrix-qa.test/Topic",
    },
    {
      source: "thread:/v1/group/Room%2FOne/Topic%2FTwo",
      translated: "thread:/v1/group/!ebcb8064d1475072:matrix-qa.test/Topic%2FTwo",
    },
  ])("preserves typed Matrix target semantics for $source", ({ source, translated }) => {
    const targets: string[] = [];
    const adapter = {
      channel: "matrix",
      createAgentDelivery: ({ target }: { target: string }) => {
        targets.push(target);
        return {
          channel: "matrix",
          providerTargetKey: "provider-target",
          replyChannel: "matrix",
          replyTo: "room:provider-target",
          to: "room:provider-target",
        };
      },
    } as const;

    createCrablineProviderDelivery(adapter, source);

    expect(targets).toEqual([translated]);
  });
});
