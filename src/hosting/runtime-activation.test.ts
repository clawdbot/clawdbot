import { describe, expect, it } from "vitest";
import {
  INCARNATION_ID_ENV,
  RUNTIME_ID_ENV,
  resolveRuntimeActivationIdentity,
} from "./runtime-activation.js";

describe("resolveRuntimeActivationIdentity", () => {
  it("uses host-supplied runtime and incarnation identities", () => {
    expect(
      resolveRuntimeActivationIdentity({
        env: {
          [RUNTIME_ID_ENV]: "tenant-42/scout-primary",
          [INCARNATION_ID_ENV]: "pod-7f9c",
        },
      }),
    ).toEqual({ runtimeId: "tenant-42/scout-primary", incarnationId: "pod-7f9c" });
  });

  it("keeps local startup zero-configuration", () => {
    expect(
      resolveRuntimeActivationIdentity({
        env: {},
        createIncarnationId: () => "generated-incarnation",
      }),
    ).toEqual({ runtimeId: "local", incarnationId: "generated-incarnation" });
  });

  it("rejects invalid identities instead of publishing ambiguous readiness", () => {
    expect(() =>
      resolveRuntimeActivationIdentity({
        runtimeId: "contains spaces",
        incarnationId: "valid",
        env: {},
      }),
    ).toThrow(`Invalid ${RUNTIME_ID_ENV}`);
  });

  it("rejects explicitly blank host identity", () => {
    expect(() =>
      resolveRuntimeActivationIdentity({
        env: { [INCARNATION_ID_ENV]: "   " },
      }),
    ).toThrow(`Invalid ${INCARNATION_ID_ENV}`);
  });

  it("keeps a generated incarnation stable across in-process Gateway restarts", () => {
    const first = resolveRuntimeActivationIdentity({ env: {} });
    const second = resolveRuntimeActivationIdentity({ env: {} });

    expect(second.incarnationId).toBe(first.incarnationId);
  });
});
