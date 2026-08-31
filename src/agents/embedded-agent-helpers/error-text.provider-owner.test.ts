import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyProviderFailoverSignalWithPlugin } from "../../plugins/provider-failover.js";
import { buildApiErrorObservationFields } from "../embedded-agent-error-observation.js";
import { classifyFailoverSignal, isContextOverflowError } from "../failover/classify.js";
import { PROVIDER_SCHEMA_REJECTION_USER_TEXT } from "../failover/user-copy.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { formatAssistantErrorText } from "./error-text.js";
import { classifyProviderRuntimeFailureKind } from "./provider-runtime-failure.js";

vi.mock("../../plugins/provider-failover.js", () => ({
  classifyProviderFailoverSignalWithPlugin: vi.fn(),
}));

describe("assistant diagnostic provider ownership", () => {
  beforeEach(() => {
    vi.mocked(classifyProviderFailoverSignalWithPlugin)
      .mockReset()
      .mockReturnValue("model_not_found");
  });

  it.each(["provider sent an opaque failure", "prompt reached the tenant maximum"])(
    "renders %j without discovering provider policy",
    (errorMessage) => {
      expect(formatAssistantErrorText(makeAssistantMessageFixture({ errorMessage }))).toBe(
        errorMessage,
      );
      expect(classifyProviderFailoverSignalWithPlugin).not.toHaveBeenCalled();
    },
  );

  it("keeps the prepared owner through schema diagnostics", () => {
    const classifyFailoverReason = vi.fn(() => "format" as const);
    expect(
      formatAssistantErrorText(
        makeAssistantMessageFixture({ errorMessage: "provider rejected this payload" }),
        { providerOwner: { id: "synthetic-owner", classifyFailoverReason } },
      ),
    ).toBe(PROVIDER_SCHEMA_REJECTION_USER_TEXT);
    expect(classifyFailoverReason).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "synthetic-owner" }),
    );
    expect(classifyProviderFailoverSignalWithPlugin).not.toHaveBeenCalled();
  });

  it("keeps the prepared owner through context diagnostics", () => {
    expect(
      formatAssistantErrorText(
        makeAssistantMessageFixture({ errorMessage: "prompt reached the tenant maximum" }),
        {
          providerOwner: {
            id: "synthetic-owner",
            matchesContextOverflowError: () => true,
          },
        },
      ),
    ).toContain("Context overflow: prompt too large for the model.");
    expect(classifyProviderFailoverSignalWithPlugin).not.toHaveBeenCalled();
  });

  it("records diagnostics without discovering provider policy", () => {
    expect(
      buildApiErrorObservationFields("provider sent an opaque failure", { provider: "openai" }),
    ).toMatchObject({ providerRuntimeFailureKind: "unclassified" });
    expect(classifyProviderFailoverSignalWithPlugin).not.toHaveBeenCalled();
  });

  it("preserves runtime discovery when no prepared owner is supplied", () => {
    expect(
      classifyFailoverSignal({ provider: "synthetic-owner", message: "opaque runtime failure" }),
    ).toEqual({ kind: "reason", reason: "model_not_found" });
    expect(classifyProviderRuntimeFailureKind("opaque runtime failure")).toBe("model_not_found");
    vi.mocked(classifyProviderFailoverSignalWithPlugin).mockReturnValue("context_overflow");
    expect(isContextOverflowError("prompt reached the tenant maximum")).toBe(true);
    expect(classifyProviderFailoverSignalWithPlugin).toHaveBeenCalledTimes(3);
  });
});
