const ANTHROPIC_STREAM_INCOMPLETE_ERROR = "Anthropic stream ended before message_stop";
const ANTHROPIC_MODEL_SSE_EVENTS = new Set([
  "message_start",
  "message_delta",
  "message_stop",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "error",
]);

export function classifyUnknownAnthropicSseFrame(
  data: string,
  parse: (data: string) => unknown,
): "ignore" | "model_event" {
  let parsed: unknown;
  try {
    parsed = parse(data);
  } catch {
    return "ignore";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "ignore";
  }
  const type = (parsed as { type?: unknown }).type;
  return typeof type === "string" && ANTHROPIC_MODEL_SSE_EVENTS.has(type)
    ? "model_event"
    : "ignore";
}

export function decodeAnthropicSseField(line: string): { field: string; value: string } {
  const separatorIndex = line.indexOf(":");
  const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
  let value = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1);
  if (value.startsWith(" ")) {
    value = value.slice(1);
  }
  return { field, value };
}

export function isMatchingAnthropicSseEventPayload(
  eventName: string,
  payload: unknown,
): payload is Record<string, unknown> & { type: string } {
  return (
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    (payload as { type?: unknown }).type === eventName
  );
}

export function anthropicSseTailHasModelFragment(tail: string): boolean {
  const normalized = tail.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = normalized.split("\n");
  const hasUnterminatedLine = !normalized.endsWith("\n");
  let eventName: string | undefined;
  let eventNameMayBePartial = false;
  const data: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line || line.startsWith(":") || line.startsWith("id:") || line.startsWith("retry:")) {
      continue;
    }
    const field = decodeAnthropicSseField(line);
    if (field.field === "event") {
      eventName = field.value;
      eventNameMayBePartial = hasUnterminatedLine && index === lines.length - 1;
      continue;
    }
    if (field.field === "data") {
      data.push(field.value);
    }
  }
  if (
    eventName &&
    (ANTHROPIC_MODEL_SSE_EVENTS.has(eventName) ||
      (eventNameMayBePartial &&
        [...ANTHROPIC_MODEL_SSE_EVENTS].some((knownEvent) => knownEvent.startsWith(eventName))))
  ) {
    return true;
  }
  const payload = data.join("\n").trim();
  if (!payload) {
    return false;
  }
  if (payload === "[DONE]") {
    return true;
  }
  try {
    const parsed = JSON.parse(payload) as { type?: unknown };
    return typeof parsed.type === "string" && ANTHROPIC_MODEL_SSE_EVENTS.has(parsed.type);
  } catch {
    const typePrefix = /"type"\s*:\s*"([^"]*)/u.exec(payload)?.[1];
    if (typePrefix !== undefined) {
      return [...ANTHROPIC_MODEL_SSE_EVENTS].some((type) => type.startsWith(typePrefix));
    }
    return payload.startsWith("{") || payload.startsWith("[");
  }
}

type AnthropicTerminalEvidence =
  | { state: "verified" }
  | {
      state: "unverified";
      reason: "compatible_structural_ambiguity";
    };

function requiresAnthropicMessageStop(params: {
  provider: string;
  endpointClass: string;
}): boolean {
  if (!params.endpointClass.trim() || params.endpointClass === "invalid") {
    return true;
  }
  if (params.endpointClass === "anthropic-public") {
    return true;
  }
  return params.endpointClass === "default";
}

export function createAnthropicStreamTerminalCompleteness(params: { requireMessageStop: boolean }) {
  let sawMessageStop = false;
  let sawMappedStopReason = false;
  let sawStandaloneDone = false;
  let sawMessageStart = false;
  let structurallyIncomplete = false;
  let structurallyAmbiguous = false;
  let protocolViolation = false;
  let phase: "before_start" | "blocks" | "message_delta" | "message_stop" = "before_start";
  const openContentBlocks = new Set<string>();
  const seenContentBlocks = new Set<string>();
  const contentBlockKey = (index: unknown): string | undefined =>
    typeof index === "number" && Number.isInteger(index) && index >= 0 ? String(index) : undefined;

  return {
    observeMessageStart(): void {
      if (phase !== "before_start" || sawMessageStart || sawStandaloneDone) {
        protocolViolation = true;
      }
      sawMessageStart = true;
      phase = "blocks";
    },
    observeContentBlockStart(index: unknown): void {
      const key = contentBlockKey(index);
      if (
        !key ||
        !sawMessageStart ||
        phase !== "blocks" ||
        openContentBlocks.has(key) ||
        seenContentBlocks.has(key)
      ) {
        protocolViolation = true;
      }
      if (key) {
        seenContentBlocks.add(key);
        openContentBlocks.add(key);
      }
    },
    observeContentBlockDelta(index: unknown): void {
      const key = contentBlockKey(index);
      if (!key || !sawMessageStart || phase !== "blocks") {
        protocolViolation = true;
      } else if (!openContentBlocks.has(key)) {
        structurallyAmbiguous = true;
      }
    },
    observeContentBlockStop(index: unknown): void {
      const key = contentBlockKey(index);
      if (!key || !sawMessageStart || phase !== "blocks") {
        protocolViolation = true;
      } else if (!openContentBlocks.has(key)) {
        structurallyAmbiguous = true;
      }
      if (key) {
        openContentBlocks.delete(key);
      }
    },
    observeMessageDelta(): void {
      if (!sawMessageStart || phase !== "blocks" || openContentBlocks.size > 0) {
        protocolViolation = true;
      }
      phase = "message_delta";
    },
    observeStructuralIncomplete(): void {
      structurallyIncomplete = true;
    },
    observeMessageStop(): void {
      if (
        !sawMessageStart ||
        sawMessageStop ||
        phase !== "message_delta" ||
        openContentBlocks.size > 0
      ) {
        structurallyIncomplete = true;
      }
      sawMessageStop = true;
      phase = "message_stop";
    },
    observeMappedStopReason(reason: string): void {
      if (!sawMessageStart || phase !== "message_delta" || sawMessageStop) {
        protocolViolation = true;
      }
      if (reason.trim().length > 0) {
        sawMappedStopReason = true;
      }
    },
    observeStandaloneDone(): void {
      if (!sawMessageStart) {
        structurallyIncomplete = true;
      } else if (sawStandaloneDone || phase === "message_stop") {
        protocolViolation = true;
      }
      sawStandaloneDone = true;
    },
    assertComplete(): AnthropicTerminalEvidence {
      if (!sawMessageStart || structurallyIncomplete || openContentBlocks.size > 0) {
        throw new Error(ANTHROPIC_STREAM_INCOMPLETE_ERROR);
      }
      const hasTerminalEvidence =
        sawMessageStop || (!params.requireMessageStop && sawMappedStopReason);
      if (!hasTerminalEvidence) {
        throw new Error(ANTHROPIC_STREAM_INCOMPLETE_ERROR);
      }
      if (protocolViolation) {
        throw new Error(ANTHROPIC_STREAM_INCOMPLETE_ERROR);
      }
      if (structurallyAmbiguous) {
        if (!params.requireMessageStop) {
          return { state: "unverified", reason: "compatible_structural_ambiguity" };
        }
        throw new Error(ANTHROPIC_STREAM_INCOMPLETE_ERROR);
      }
      return { state: "verified" };
    },
  };
}

export type AnthropicEndpointAuthoritySnapshot = {
  endpointClass?: string;
  requiresMessageStop: boolean;
  traceState: "exact" | "partial" | "unknown";
};

export function createAnthropicEndpointAuthority(params: {
  provider: string;
  resolveEndpointClass: (url?: string) => string;
}) {
  const provisionalEndpointClasses: string[] = [];
  const dispatchedAuthorities: Array<{
    attested: boolean;
    endpointClass?: string;
    origin?: string;
  }> = [];

  const resolveOrigin = (url: string): string | undefined => {
    try {
      const origin = new URL(url).origin;
      return origin === "null" ? undefined : origin;
    } catch {
      return undefined;
    }
  };

  return {
    observeProvisional(url?: string): void {
      try {
        provisionalEndpointClasses.push(params.resolveEndpointClass(url));
      } catch {
        provisionalEndpointClasses.push("");
      }
    },
    observePhysicalDispatch(url: string, options?: { attested?: boolean }): void {
      let endpointClass: string | undefined;
      try {
        endpointClass = params.resolveEndpointClass(url) || undefined;
      } catch {
        endpointClass = undefined;
      }
      const origin = resolveOrigin(url);
      dispatchedAuthorities.push({
        attested: options?.attested ?? true,
        ...(endpointClass ? { endpointClass } : {}),
        ...(origin ? { origin } : {}),
      });
    },
    snapshot(): AnthropicEndpointAuthoritySnapshot {
      const finalDispatched = dispatchedAuthorities.at(-1)?.endpointClass;
      const finalProvisional = provisionalEndpointClasses.at(-1);
      const endpointClass =
        dispatchedAuthorities.length > 0 ? finalDispatched : finalProvisional || undefined;
      const knownDispatchClasses = dispatchedAuthorities.flatMap((authority) =>
        authority.endpointClass ? [authority.endpointClass] : [],
      );
      const knownDispatchOrigins = dispatchedAuthorities.flatMap((authority) =>
        authority.origin ? [authority.origin] : [],
      );
      const hasUnknownDispatch = dispatchedAuthorities.some(
        (authority) => !authority.endpointClass || !authority.origin || !authority.attested,
      );
      const hasAuthorityConflict =
        new Set(knownDispatchClasses).size > 1 || new Set(knownDispatchOrigins).size > 1;
      const traceState =
        dispatchedAuthorities.length === 0
          ? endpointClass
            ? "partial"
            : "unknown"
          : hasUnknownDispatch || hasAuthorityConflict
            ? "partial"
            : endpointClass
              ? "exact"
              : "unknown";
      const endpointRequiresMessageStop =
        !endpointClass ||
        requiresAnthropicMessageStop({
          provider: params.provider,
          endpointClass,
        });
      return {
        ...(endpointClass ? { endpointClass } : {}),
        requiresMessageStop: endpointRequiresMessageStop || traceState !== "exact",
        traceState,
      };
    },
  };
}
