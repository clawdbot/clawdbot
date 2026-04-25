import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import { readDiscordComponentSpec, type DiscordComponentMessageSpec } from "./components.js";

type DiscordComponentSendFn = typeof import("./send.components.js").sendDiscordComponentMessage;
type DiscordSharedInteractiveModule = typeof import("./shared-interactive.js");
type OutboundPayload = Parameters<NonNullable<ChannelOutboundAdapter["sendPayload"]>>[0]["payload"];

let discordComponentSendPromise: Promise<DiscordComponentSendFn> | undefined;
let discordSharedInteractivePromise: Promise<DiscordSharedInteractiveModule> | undefined;

export async function sendDiscordComponentMessageLazy(
  ...args: Parameters<DiscordComponentSendFn>
): ReturnType<DiscordComponentSendFn> {
  discordComponentSendPromise ??= import("./send.components.js").then(
    (module) => module.sendDiscordComponentMessage,
  );
  return await (
    await discordComponentSendPromise
  )(...args);
}

function loadDiscordSharedInteractive(): Promise<DiscordSharedInteractiveModule> {
  discordSharedInteractivePromise ??= import("./shared-interactive.js");
  return discordSharedInteractivePromise;
}

function addPayloadTextFallback(
  spec: DiscordComponentMessageSpec,
  payload: Pick<OutboundPayload, "text">,
): DiscordComponentMessageSpec {
  return spec.text
    ? spec
    : {
        ...spec,
        text: payload.text?.trim() ? payload.text : undefined,
      };
}

export async function buildDiscordPresentationPayload(params: {
  payload: Parameters<NonNullable<ChannelOutboundAdapter["renderPresentation"]>>[0]["payload"];
  presentation: Parameters<
    NonNullable<ChannelOutboundAdapter["renderPresentation"]>
  >[0]["presentation"];
}): Promise<typeof params.payload | null> {
  const componentSpec = (await loadDiscordSharedInteractive()).buildDiscordPresentationComponents(
    params.presentation,
  );
  if (!componentSpec) {
    return null;
  }
  return {
    ...params.payload,
    channelData: {
      ...params.payload.channelData,
      discord: {
        ...(params.payload.channelData?.discord as Record<string, unknown> | undefined),
        presentationComponents: componentSpec,
      },
    },
  };
}

export async function resolveDiscordComponentSpec(
  payload: OutboundPayload,
): Promise<DiscordComponentMessageSpec | undefined> {
  const discordData = payload.channelData?.discord as
    | { components?: unknown; presentationComponents?: DiscordComponentMessageSpec }
    | undefined;
  const rawComponentSpec =
    discordData?.presentationComponents ?? readDiscordComponentSpec(discordData?.components);
  if (rawComponentSpec) {
    return addPayloadTextFallback(rawComponentSpec, payload);
  }
  if (!payload.interactive) {
    return undefined;
  }
  const interactiveSpec = (await loadDiscordSharedInteractive()).buildDiscordInteractiveComponents(
    payload.interactive,
  );
  return interactiveSpec ? addPayloadTextFallback(interactiveSpec, payload) : undefined;
}
