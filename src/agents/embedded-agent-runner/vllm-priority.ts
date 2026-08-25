import { isPrivateOrLoopbackIpAddress } from "@openclaw/net-policy/ip";
import type { InboundEventKind } from "../../channels/inbound-event/kind.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type { BootstrapContextRunKind } from "../bootstrap-mode.js";
import type { TrustedSubagentCompletionHandoff } from "../subagents/announce/subagent-announce-handoff.js";
import type { EmbeddedRunTrigger } from "./run/params.js";

export type ModelCallUrgency = "foreground" | "normal" | "background";

type VllmPriorityProvenance = {
  trigger?: EmbeddedRunTrigger;
  bootstrapContextRunKind?: BootstrapContextRunKind;
  currentInboundEventKind?: InboundEventKind;
  inputProvenance?: InputProvenance;
  spawnedBy?: string | null;
  trustedInternalHandoff?: boolean | TrustedSubagentCompletionHandoff;
};

type VllmPriority = -100 | 0 | 100;

function isPrivateModelEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) {
    return false;
  }
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return hostname === "localhost" || isPrivateOrLoopbackIpAddress(hostname);
  } catch {
    return false;
  }
}

function isVllmCompatibleModel(model: ProviderRuntimeModel | undefined): boolean {
  return model?.api === "openai-completions" && isPrivateModelEndpoint(model.baseUrl);
}

export function resolveModelCallUrgency(provenance: VllmPriorityProvenance): ModelCallUrgency {
  const backgroundRunKind =
    provenance.bootstrapContextRunKind === "cron" ||
    provenance.bootstrapContextRunKind === "heartbeat";
  const backgroundTrigger =
    provenance.trigger === "cron" ||
    provenance.trigger === "heartbeat" ||
    provenance.trigger === "memory";
  if (backgroundRunKind || backgroundTrigger) {
    return "background";
  }
  if (
    provenance.spawnedBy ||
    Boolean(provenance.trustedInternalHandoff) ||
    provenance.inputProvenance?.kind === "inter_session" ||
    provenance.inputProvenance?.kind === "internal_system"
  ) {
    return "normal";
  }
  if (
    provenance.currentInboundEventKind === "user_request" ||
    provenance.inputProvenance?.kind === "external_user" ||
    provenance.trigger === "user"
  ) {
    return "foreground";
  }
  return "normal";
}

function priorityForUrgency(urgency: ModelCallUrgency): VllmPriority {
  switch (urgency) {
    case "foreground":
      return -100;
    case "background":
      return 100;
    default:
      return 0;
  }
}

function readExtraBody(extraParams: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!extraParams) {
    return {};
  }
  const value = Object.hasOwn(extraParams, "extra_body")
    ? extraParams.extra_body
    : extraParams.extraBody;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hasExtraBodyParam(extraParams: Record<string, unknown> | undefined): boolean {
  return Boolean(
    extraParams &&
    (Object.hasOwn(extraParams, "extra_body") || Object.hasOwn(extraParams, "extraBody")),
  );
}

function withPriority(
  extraParams: Record<string, unknown>,
  priority: VllmPriority,
): Record<string, unknown> {
  const { extra_body: _extraBodySnake, extraBody: _extraBodyCamel, ...rest } = extraParams;
  return {
    ...rest,
    extraBody: {
      ...readExtraBody(extraParams),
      priority,
    },
  };
}

function withoutPriority(extraParams: Record<string, unknown>): Record<string, unknown> {
  const extraBody = readExtraBody(extraParams);
  if (!Object.hasOwn(extraBody, "priority")) {
    return extraParams;
  }
  const { priority: _priority, ...extraBodyWithoutPriority } = extraBody;
  const { extra_body: _extraBodySnake, extraBody: _extraBodyCamel, ...rest } = extraParams;
  return Object.keys(extraBodyWithoutPriority).length > 0
    ? { ...rest, extraBody: extraBodyWithoutPriority }
    : rest;
}

/**
 * Rewrites the neutral configured marker into a request priority. The marker is
 * intentionally read from configured params so request overrides cannot opt an
 * arbitrary OpenAI-compatible endpoint into vLLM-only payload fields.
 */
export function prepareVllmPriorityExtraParams(params: {
  configuredExtraParams?: Record<string, unknown>;
  effectiveExtraParams: Record<string, unknown>;
  extraParamsOverride?: Record<string, unknown>;
  model?: ProviderRuntimeModel;
  urgency: ModelCallUrgency;
}): {
  effectiveExtraParams: Record<string, unknown>;
  extraParamsOverride?: Record<string, unknown>;
} {
  const optedIn =
    isVllmCompatibleModel(params.model) &&
    readExtraBody(params.configuredExtraParams).priority === 0;
  const priority = priorityForUrgency(params.urgency);
  const effectiveExtraParams = optedIn
    ? withPriority(params.effectiveExtraParams, priority)
    : withoutPriority(params.effectiveExtraParams);
  if (!params.extraParamsOverride) {
    return { effectiveExtraParams };
  }
  const extraParamsOverride = hasExtraBodyParam(params.extraParamsOverride)
    ? optedIn
      ? withPriority(params.extraParamsOverride, priority)
      : withoutPriority(params.extraParamsOverride)
    : params.extraParamsOverride;
  return { effectiveExtraParams, extraParamsOverride };
}
