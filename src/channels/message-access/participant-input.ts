import type { MsgContext } from "../../auto-reply/templating.js";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import { prepareSessionParticipantInput } from "../../sessions/session-participant-input.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { readChannelIngressHostOwner, type ChannelIngressHostOwner } from "./ingress-host-owner.js";
import type {
  ChannelIngressContextBinding,
  ResolvedChannelMessageIngress,
} from "./runtime-types.js";

type ChannelInput = {
  identity: Extract<SessionParticipantIdentity, { type: "remote" | "observation" }>;
  binding: ChannelIngressContextBinding;
  promptedAt: number;
  owner: ChannelIngressHostOwner;
};
const inputs = resolveGlobalSingleton(
  Symbol.for("openclaw.channelParticipantInputs"),
  () => new WeakMap<ResolvedChannelMessageIngress, ChannelInput>(),
);

/** Raw product facts stay private; the public ingress result remains redacted diagnostic data. */
export function prepareChannelParticipantInput(
  result: ResolvedChannelMessageIngress,
  input: ChannelInput,
): void {
  inputs.set(result, input);
}

export function bindChannelParticipantInput(params: {
  context: MsgContext;
  channelId: string;
  ingress:
    | ResolvedChannelMessageIngress
    | readonly ResolvedChannelMessageIngress[]
    | "unsupported"
    | undefined;
  binding: ChannelIngressContextBinding;
  owner: ChannelIngressHostOwner;
}): void {
  if (!params.ingress || params.ingress === "unsupported") {
    return;
  }
  const resolutions = Array.isArray(params.ingress) ? params.ingress : [params.ingress];
  const batch = resolutions.map((result) => {
    const input = inputs.get(result);
    inputs.delete(result);
    return input;
  });
  // Batched ingress uses the final transport message id; every source keeps its own accepted time.
  if (
    batch.at(-1)?.binding.messageId !== params.binding.messageId ||
    params.owner !== readChannelIngressHostOwner(params.channelId) ||
    !params.owner.isLive() ||
    batch.some(
      (input) =>
        !input ||
        input.owner !== params.owner ||
        input.identity.pluginId !== params.channelId ||
        input.binding.agentId !== params.binding.agentId ||
        input.binding.sessionKey !== params.binding.sessionKey ||
        input.binding.nativeChannelId !== params.binding.nativeChannelId ||
        input.binding.inboundEventKind !== params.binding.inboundEventKind,
    )
  ) {
    return;
  }
  for (const input of batch) {
    if (input) {
      prepareSessionParticipantInput(params.context, input.identity, input.promptedAt);
    }
  }
}
