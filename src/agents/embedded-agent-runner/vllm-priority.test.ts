import { describe, expect, it } from "vitest";
import { prepareVllmPriorityExtraParams, resolveModelCallUrgency } from "./vllm-priority.js";

const localModel = {
  provider: "local",
  id: "qwen",
  api: "openai-completions" as const,
  baseUrl: "http://192.168.100.11:8000/v1",
  input: ["text"],
};

describe("resolveModelCallUrgency", () => {
  it.each([
    ["channel request", { currentInboundEventKind: "user_request" as const }],
    ["external user", { inputProvenance: { kind: "external_user" as const } }],
    ["direct CLI or gateway user", { trigger: "user" as const }],
  ])("classifies %s as foreground", (_name, provenance) => {
    expect(resolveModelCallUrgency(provenance)).toBe("foreground");
  });

  it.each([
    ["inter-session input", { inputProvenance: { kind: "inter_session" as const } }],
    ["internal input", { inputProvenance: { kind: "internal_system" as const } }],
    ["spawned work", { trigger: "user" as const, spawnedBy: "agent:parent:main" }],
    ["trusted handoff", { trigger: "user" as const, trustedInternalHandoff: true }],
  ])("classifies %s as normal", (_name, provenance) => {
    expect(resolveModelCallUrgency(provenance)).toBe("normal");
  });

  it.each([
    ["cron trigger", { trigger: "cron" as const }],
    ["heartbeat run", { bootstrapContextRunKind: "heartbeat" as const }],
    ["memory run", { trigger: "memory" as const }],
  ])("classifies %s as background", (_name, provenance) => {
    expect(resolveModelCallUrgency(provenance)).toBe("background");
  });

  it("keeps heartbeat precedence over external-user and spawned signals", () => {
    expect(
      resolveModelCallUrgency({
        trigger: "heartbeat",
        currentInboundEventKind: "user_request",
        inputProvenance: { kind: "external_user" },
        spawnedBy: "agent:parent:main",
      }),
    ).toBe("background");
  });
});

describe("prepareVllmPriorityExtraParams", () => {
  it("rewrites a camel-case neutral marker and preserves body siblings", () => {
    expect(
      prepareVllmPriorityExtraParams({
        configuredExtraParams: { extraBody: { priority: 0 } },
        effectiveExtraParams: {
          temperature: 0.2,
          extraBody: { priority: 0, guided_decoding_backend: "outlines" },
        },
        model: localModel,
        urgency: "foreground",
      }),
    ).toEqual({
      effectiveExtraParams: {
        temperature: 0.2,
        extraBody: { priority: -100, guided_decoding_backend: "outlines" },
      },
    });
  });

  it("supports a snake-case neutral marker and request body override", () => {
    expect(
      prepareVllmPriorityExtraParams({
        configuredExtraParams: { extra_body: { priority: 0 } },
        effectiveExtraParams: { extra_body: { priority: 0, service_tier: "auto" } },
        extraParamsOverride: { extra_body: { guided_decoding_backend: "outlines" } },
        model: localModel,
        urgency: "background",
      }),
    ).toEqual({
      effectiveExtraParams: { extraBody: { priority: 100, service_tier: "auto" } },
      extraParamsOverride: {
        extraBody: { priority: 100, guided_decoding_backend: "outlines" },
      },
    });
  });

  it("accepts an arbitrary provider id for an opted-in private endpoint", () => {
    expect(
      prepareVllmPriorityExtraParams({
        configuredExtraParams: { extraBody: { priority: 0 } },
        effectiveExtraParams: { extraBody: { priority: 0, service_tier: "auto" } },
        model: { ...localModel, provider: "spark2" },
        urgency: "foreground",
      }),
    ).toEqual({
      effectiveExtraParams: { extraBody: { priority: -100, service_tier: "auto" } },
    });
  });

  it("does not treat a legacy nonzero priority as opt-in", () => {
    expect(
      prepareVllmPriorityExtraParams({
        configuredExtraParams: { extraBody: { priority: -100 } },
        effectiveExtraParams: { extraBody: { priority: -100, service_tier: "auto" } },
        model: localModel,
        urgency: "foreground",
      }),
    ).toEqual({
      effectiveExtraParams: { extraBody: { service_tier: "auto" } },
    });
  });

  it("rejects a request-scoped neutral marker without configured opt-in", () => {
    expect(
      prepareVllmPriorityExtraParams({
        configuredExtraParams: { temperature: 0.2 },
        effectiveExtraParams: { extraBody: { priority: 0, service_tier: "auto" } },
        extraParamsOverride: { extraBody: { priority: 0, request_field: true } },
        model: localModel,
        urgency: "foreground",
      }),
    ).toEqual({
      effectiveExtraParams: { extraBody: { service_tier: "auto" } },
      extraParamsOverride: { extraBody: { request_field: true } },
    });
  });

  it("strips the private-endpoint priority marker from cloud fallback without dropping siblings", () => {
    expect(
      prepareVllmPriorityExtraParams({
        configuredExtraParams: { extraBody: { priority: 0 } },
        effectiveExtraParams: { extraBody: { priority: 0, service_tier: "auto" } },
        extraParamsOverride: { extra_body: { priority: 0, request_field: true } },
        model: {
          provider: "kilo",
          id: "cloud-model",
          api: "openai-completions",
          baseUrl: "https://api.kilo.ai/v1",
          input: ["text"],
        },
        urgency: "background",
      }),
    ).toEqual({
      effectiveExtraParams: { extraBody: { service_tier: "auto" } },
      extraParamsOverride: { extraBody: { request_field: true } },
    });
  });
});
