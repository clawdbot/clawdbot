import { describe, expect, it } from "vitest";
import {
  captureRuntimeAuthProfileStorePublicationToken,
  consumeRuntimeAuthProfileStorePublicationToken,
  getRuntimeAuthProfileStorePublicationGeneration,
} from "./runtime-publication-order.js";

describe("runtime auth publication order", () => {
  it("keeps a pending main token current during unrelated owner churn", () => {
    const mainToken = captureRuntimeAuthProfileStorePublicationToken(undefined, {
      advanceOwner: true,
    });
    for (let index = 0; index < 300; index += 1) {
      const unrelatedToken = captureRuntimeAuthProfileStorePublicationToken(
        `/tmp/openclaw-auth-owner-${index}`,
        {
          advanceOwner: true,
        },
      );
      expect(consumeRuntimeAuthProfileStorePublicationToken(unrelatedToken)).toBe("current");
    }

    expect(consumeRuntimeAuthProfileStorePublicationToken(mainToken)).toBe("current");
  });

  it("does not revive a stale token during unrelated owner churn", () => {
    const targetAgentDir = "/tmp/openclaw-auth-stale-owner";
    const staleToken = captureRuntimeAuthProfileStorePublicationToken(targetAgentDir);
    const newerToken = captureRuntimeAuthProfileStorePublicationToken(targetAgentDir, {
      advanceOwner: true,
    });
    expect(consumeRuntimeAuthProfileStorePublicationToken(newerToken)).toBe("current");

    for (let index = 0; index < 300; index += 1) {
      const unrelatedToken = captureRuntimeAuthProfileStorePublicationToken(
        `/tmp/openclaw-auth-stale-unrelated-${index}`,
        {
          advanceOwner: true,
        },
      );
      expect(consumeRuntimeAuthProfileStorePublicationToken(unrelatedToken)).toBe("current");
    }

    expect(consumeRuntimeAuthProfileStorePublicationToken(staleToken)).toBe("owner-superseded");
    expect(consumeRuntimeAuthProfileStorePublicationToken(staleToken)).toBe("consumed");
  });

  it("does not release a shared main generation twice", () => {
    const firstToken = captureRuntimeAuthProfileStorePublicationToken(undefined, {
      advanceOwner: true,
    });
    const secondToken = captureRuntimeAuthProfileStorePublicationToken();
    expect(consumeRuntimeAuthProfileStorePublicationToken(firstToken)).toBe("current");
    expect(consumeRuntimeAuthProfileStorePublicationToken(firstToken)).toBe("consumed");

    for (let index = 0; index < 300; index += 1) {
      const unrelatedToken = captureRuntimeAuthProfileStorePublicationToken(
        `/tmp/openclaw-auth-shared-main-unrelated-${index}`,
        { advanceOwner: true },
      );
      expect(consumeRuntimeAuthProfileStorePublicationToken(unrelatedToken)).toBe("current");
    }

    expect(consumeRuntimeAuthProfileStorePublicationToken(secondToken)).toBe("current");
  });

  it("keeps a precommit inherited main generation superseded after eviction", () => {
    const inheritedMainGeneration = getRuntimeAuthProfileStorePublicationGeneration();
    const newerMainToken = captureRuntimeAuthProfileStorePublicationToken(undefined, {
      advanceOwner: true,
    });
    expect(consumeRuntimeAuthProfileStorePublicationToken(newerMainToken)).toBe("current");

    for (let index = 0; index < 300; index += 1) {
      const unrelatedToken = captureRuntimeAuthProfileStorePublicationToken(
        `/tmp/openclaw-auth-precommit-unrelated-${index}`,
        { advanceOwner: true },
      );
      expect(consumeRuntimeAuthProfileStorePublicationToken(unrelatedToken)).toBe("current");
    }

    const derivedToken = captureRuntimeAuthProfileStorePublicationToken(
      "/tmp/openclaw-auth-precommit-derived",
      {
        advanceOwner: true,
        inheritedMainGeneration,
      },
    );
    expect(consumeRuntimeAuthProfileStorePublicationToken(derivedToken)).toBe("main-superseded");
  });

  it("does not supersede an unchanged inherited main generation during churn", () => {
    const inheritedMainGeneration = getRuntimeAuthProfileStorePublicationGeneration();
    for (let index = 0; index < 300; index += 1) {
      const unrelatedToken = captureRuntimeAuthProfileStorePublicationToken(
        `/tmp/openclaw-auth-unchanged-main-unrelated-${index}`,
        { advanceOwner: true },
      );
      expect(consumeRuntimeAuthProfileStorePublicationToken(unrelatedToken)).toBe("current");
    }

    const derivedToken = captureRuntimeAuthProfileStorePublicationToken(
      "/tmp/openclaw-auth-unchanged-main-derived",
      {
        advanceOwner: true,
        inheritedMainGeneration,
      },
    );
    expect(consumeRuntimeAuthProfileStorePublicationToken(derivedToken)).toBe("current");
  });
});
