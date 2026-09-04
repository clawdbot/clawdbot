import type { CanvasesEditArguments } from "@slack/web-api";
import { z } from "zod";
import { getSlackWriteClient } from "./client.js";
import { formatSlackTarget } from "./target-parsing.js";

const canvasMarkdown = z
  .string()
  .min(1)
  .max(1048576)
  .refine((value) => value.trim().length > 0);
const canvasSectionId = z.string().trim().min(1);
const canvasEdit = z.discriminatedUnion("canvasOperation", [
  z.object({
    canvasOperation: z.enum(["insert_before", "insert_after"]),
    canvasSectionId,
    canvasMarkdown,
  }),
  z.object({
    canvasOperation: z.enum(["insert_at_start", "insert_at_end"]),
    canvasSectionId: z.never().optional(),
    canvasMarkdown,
  }),
  z.object({
    canvasOperation: z.literal("replace"),
    canvasSectionId: canvasSectionId.optional(),
    canvasMarkdown,
  }),
  z.object({
    canvasOperation: z.literal("delete"),
    canvasSectionId,
    canvasMarkdown: z.never().optional(),
  }),
]);

export function parseSlackCanvasInput(params: Record<string, unknown>) {
  for (const key of [
    "threadId",
    "threadTs",
    "replyTo",
    "topLevel",
    "replyBroadcast",
    "message",
    "messageId",
    "message_id",
    "content",
    "media",
    "mediaUrl",
    "buffer",
    "attachments",
    "presentation",
    "blocks",
  ]) {
    if (params[key] !== undefined) {
      throw new Error(
        `Slack canvas actions do not support ${key}; target the channel and use canvas fields.`,
      );
    }
  }
  if (params.action === "createCanvas") {
    const input = z
      .object({
        canvasMarkdown,
        canvasTitle: z.string().trim().min(1).optional(),
        canvasId: z.never().optional(),
        canvasOperation: z.never().optional(),
        canvasSectionId: z.never().optional(),
      })
      .parse(params);
    return { action: "create" as const, ...input };
  }
  z.object({ action: z.literal("editCanvas"), canvasTitle: z.never().optional() }).parse(params);
  const canvasId = z
    .string()
    .trim()
    .regex(/^F[A-Z0-9]+$/)
    .parse(params.canvasId);
  const edit = canvasEdit.parse(params);
  let change: CanvasesEditArguments["changes"][number];
  if (edit.canvasOperation === "delete") {
    change = { operation: edit.canvasOperation, section_id: edit.canvasSectionId };
  } else if (edit.canvasOperation === "insert_before" || edit.canvasOperation === "insert_after") {
    change = {
      operation: edit.canvasOperation,
      section_id: edit.canvasSectionId,
      document_content: { type: "markdown", markdown: edit.canvasMarkdown },
    };
  } else {
    change = {
      operation: edit.canvasOperation,
      document_content: { type: "markdown", markdown: edit.canvasMarkdown },
      ...(edit.canvasSectionId ? { section_id: edit.canvasSectionId } : {}),
    };
  }
  return { action: "edit" as const, canvasId, change };
}

export async function mutateSlackChannelCanvas(
  input: ReturnType<typeof parseSlackCanvasInput>,
  target: { channelId: string; teamId?: string },
  botToken: string,
  assertChannelAllowed: (name: string | undefined) => void,
) {
  const client = getSlackWriteClient(botToken, { teamId: target.teamId });
  // Never authorize an arbitrary canvas by pairing it with an allowed channel.
  // Inspect fresh association metadata with the same identity used for the write.
  const info = await client.conversations.info({ channel: target.channelId });
  const channel = info.channel;
  if (
    !channel ||
    channel.id !== target.channelId ||
    channel.is_im ||
    channel.is_mpim ||
    !(channel.is_channel || channel.is_group)
  ) {
    throw new Error("Slack canvas actions require a verified channel, not a DM or group DM.");
  }
  assertChannelAllowed(channel.name?.trim() || undefined);
  // SDK conversations.info omits properties; Slack's channel object supplies it.
  const association = z
    .object({
      properties: z
        .object({
          canvas: z.object({ file_id: z.string().optional() }).optional(),
        })
        .optional(),
    })
    .parse(channel).properties?.canvas?.file_id;
  let canvasId: string;
  if (input.action === "create") {
    if (association) {
      throw new Error(
        `This Slack channel already has canvas ${association}. Use canvas-edit with that canvasId.`,
      );
    }
    const created = await client.conversations.canvases.create({
      channel_id: target.channelId,
      ...(input.canvasTitle ? { title: input.canvasTitle } : {}),
      document_content: { type: "markdown", markdown: input.canvasMarkdown },
    });
    if (!created.canvas_id || !/^F[A-Z0-9]+$/.test(created.canvas_id)) {
      throw new Error(
        "Slack did not return a canvas ID. Check the channel canvas before retrying creation.",
      );
    }
    canvasId = created.canvas_id;
  } else {
    if (association !== input.canvasId) {
      throw new Error(
        "Slack canvasId does not match the target channel's canvas. Check the channel and canvas IDs.",
      );
    }
    // The API permits one operation per call. The write client does not retry
    // ambiguous mutations, which could duplicate inserted content.
    await client.canvases.edit({ canvas_id: input.canvasId, changes: [input.change] });
    canvasId = input.canvasId;
  }
  return {
    channelId: target.channelId,
    canvasId,
    target: formatSlackTarget({ teamId: target.teamId, kind: "channel", id: target.channelId }),
  };
}
