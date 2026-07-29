// Discord plugin module implements outbound components behavior.
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import {
  createLazyRuntimeModule,
  createLazyRuntimeNamedExport,
} from "openclaw/plugin-sdk/lazy-runtime";
import { readDiscordComponentSpec, type DiscordComponentMessageSpec } from "./components.js";

type DiscordComponentSendFn = typeof import("./send.components.js").sendDiscordComponentMessage;
type OutboundPayload = Parameters<NonNullable<ChannelOutboundAdapter["sendPayload"]>>[0]["payload"];

const DISCORD_MESSAGE_COMPONENT_LIMIT = 40;
const DISCORD_TEXT_DISPLAY_LIMIT = 2000;
const DISCORD_CONTEXT_PREFIX_LENGTH = Array.from("-# ").length;

const DISCORD_PRESENTATION_TEXT_LIMIT = DISCORD_TEXT_DISPLAY_LIMIT - DISCORD_CONTEXT_PREFIX_LENGTH;

export const DISCORD_PRESENTATION_CAPABILITIES = {
  supported: true,
  buttons: true,
  selects: true,
  context: true,
  divider: true,
  charts: false,
  limits: {
    actions: {
      maxActions: 25,
      maxActionsPerRow: 5,
      maxRows: 5,
      maxLabelLength: 80,
      supportsDisabled: true,
    },
    selects: {
      maxOptions: 25,
      maxLabelLength: 100,
      maxValueBytes: 100,
    },
    text: {
      maxLength: DISCORD_PRESENTATION_TEXT_LIMIT,
      encoding: "characters",
      markdownDialect: "discord-markdown",
    },
  },
} satisfies NonNullable<ChannelOutboundAdapter["presentationCapabilities"]>;

const loadDiscordComponentSend = createLazyRuntimeNamedExport(
  () => import("./send.components.js"),
  "sendDiscordComponentMessage",
);

export async function sendDiscordComponentMessageLazy(
  ...args: Parameters<DiscordComponentSendFn>
): ReturnType<DiscordComponentSendFn> {
  return await (
    await loadDiscordComponentSend()
  )(...args);
}

const loadDiscordSharedInteractive = createLazyRuntimeModule(
  () => import("./shared-interactive.js"),
);

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

function countDiscordComponentBlock(
  block: NonNullable<DiscordComponentMessageSpec["blocks"]>[number],
) {
  if (block.type === "section") {
    const textCount = block.texts?.length ? block.texts.length : block.text ? 1 : 0;
    return 1 + textCount + (block.accessory ? 1 : 0);
  }
  if (block.type === "actions") {
    return 1 + (block.buttons?.length ?? (block.select ? 1 : 0));
  }
  return 1;
}

function countDiscordMessageComponents(params: {
  spec: DiscordComponentMessageSpec;
  includesMedia: boolean;
}): number {
  const blocks = params.spec.blocks ?? [];
  let count = 1 + (params.spec.text ? 1 : 0);
  for (const block of blocks) {
    count += countDiscordComponentBlock(block);
  }

  if (params.spec.modal) {
    const lastBlock = blocks.at(-1);
    const triggerFitsLastRow =
      lastBlock?.type === "actions" && !lastBlock.select && (lastBlock.buttons?.length ?? 0) < 5;
    count += triggerFitsLastRow ? 1 : 2;
  }

  const hasFileBlock = blocks.some((block) => block.type === "file");
  if (params.includesMedia && !hasFileBlock) {
    count += 1;
  }
  return count;
}

export function isDiscordComponentSpecWithinMessageLimit(params: {
  spec: DiscordComponentMessageSpec;
  fallbackText?: string;
  includesMedia?: boolean;
}): boolean {
  const countedSpec = addPayloadTextFallback(params.spec, { text: params.fallbackText });
  if (countedSpec.text && Array.from(countedSpec.text).length > DISCORD_TEXT_DISPLAY_LIMIT) {
    return false;
  }
  return (
    countDiscordMessageComponents({
      spec: countedSpec,
      includesMedia: params.includesMedia === true,
    }) <= DISCORD_MESSAGE_COMPONENT_LIMIT
  );
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
  const includesMedia = Boolean(
    params.payload.mediaUrl || params.payload.mediaUrls?.some((mediaUrl) => mediaUrl),
  );
  // Discord counts the container and every nested child toward the 40-component
  // envelope. Let core use normal text chunking rather than submit an invalid V2 tree.
  if (
    !isDiscordComponentSpecWithinMessageLimit({
      spec: componentSpec,
      fallbackText: params.payload.text,
      includesMedia,
    })
  ) {
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
    discordData?.presentationComponents ??
    (discordData?.components &&
    typeof discordData.components === "object" &&
    !Array.isArray(discordData.components)
      ? readDiscordComponentSpec(discordData.components)
      : null);
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
