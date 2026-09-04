import {
  buildChannelProgressDraftLineForEntry,
  type ChannelProgressDraftLine,
  type ChannelProgressDraftLineInput,
  type ChannelProgressLineOptions,
  type StreamingCompatEntry,
} from "./streaming.js";

type ProgressPayload<TEvent extends ChannelProgressDraftLineInput["event"]> = Omit<
  Extract<ChannelProgressDraftLineInput, { event: TEvent }>,
  "event"
>;

type ToolProgressPayload = ProgressPayload<"tool"> & { detailMode?: "explain" | "raw" };
type ItemProgressPayload = Omit<ProgressPayload<"item">, "itemKind"> & { kind?: string };
type ChannelProgressDraftEventLine = string | ChannelProgressDraftLine;
export type ChannelProgressDraftEventLineBuilder = (
  input: ChannelProgressDraftLineInput,
  options?: ChannelProgressLineOptions,
) => ChannelProgressDraftEventLine | undefined;

export function createChannelProgressDraftEventHandlers(params: {
  entry: StreamingCompatEntry | null | undefined;
  buildLine?: ChannelProgressDraftEventLineBuilder;
  onTool?: (payload: ToolProgressPayload) => void;
  onItem?: (payload: ItemProgressPayload) => void;
  pushLine: (
    line: ChannelProgressDraftEventLine | undefined,
    options?: { toolName?: string; startImmediately?: boolean },
  ) => Promise<boolean>;
}) {
  const pushEvent = (
    input: Exclude<ChannelProgressDraftLineInput, { event: "plan" }>,
    detailMode?: "explain" | "raw",
  ) => {
    const lineOptions = detailMode ? { detailMode } : undefined;
    const line = params.buildLine
      ? params.buildLine(input, lineOptions)
      : buildChannelProgressDraftLineForEntry(params.entry, input, lineOptions);
    return params.pushLine(line, input.event === "tool" ? { toolName: input.name?.trim() } : {});
  };

  return {
    pushToolEvent: (payload: ToolProgressPayload) => {
      const { detailMode, ...input } = payload;
      params.onTool?.(payload);
      return pushEvent({ event: "tool", ...input }, detailMode);
    },
    pushItemEvent: (payload: ItemProgressPayload) => {
      const { kind: itemKind, ...input } = payload;
      params.onItem?.(payload);
      return pushEvent({ event: "item", ...input, itemKind });
    },
    pushApprovalEvent: (payload: ProgressPayload<"approval">) => {
      return payload.phase === "requested"
        ? pushEvent({ event: "approval", ...payload })
        : Promise.resolve(false);
    },
    pushCommandOutputEvent: (payload: ProgressPayload<"command-output">) => {
      return payload.phase === "end"
        ? pushEvent({ event: "command-output", ...payload })
        : Promise.resolve(false);
    },
    pushPatchEvent: (payload: ProgressPayload<"patch">) => {
      return payload.phase === "end"
        ? pushEvent({ event: "patch", ...payload })
        : Promise.resolve(false);
    },
  };
}
