import { describe, expect, it } from "vitest";
import {
  bindActiveOperatorTurnAuthority,
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "./cron-creator-authority-context.js";

describe("bindActiveOperatorTurnAuthority", () => {
  it("binds an explicit exact-run origin and expires retained authority", async () => {
    const capability = createCronCreatorAuthorityCapability("owner-run", {
      kind: "external",
      channel: "discord",
    });
    if (!capability) {
      throw new Error("expected capability");
    }
    let retained: ReturnType<typeof bindActiveOperatorTurnAuthority>;

    await runWithCronCreatorAuthorityCapability(capability, async () => {
      expect(bindActiveOperatorTurnAuthority("other-run")).toBeUndefined();
      retained = bindActiveOperatorTurnAuthority("owner-run");
      expect(retained?.source).toBe("channel-owner");
      expect(() => retained?.assertActive()).not.toThrow();
    });

    expect(() => retained?.assertActive()).toThrow();
  });

  it("does not promote an unknown active origin", async () => {
    const capability = createCronCreatorAuthorityCapability("unknown-run");
    if (!capability) {
      throw new Error("expected capability");
    }

    await runWithCronCreatorAuthorityCapability(capability, async () => {
      expect(bindActiveOperatorTurnAuthority("unknown-run")).toBeUndefined();
    });
  });
});
