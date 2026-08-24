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

type DetailMode = "explain" | "raw" | "plain";
type ToolProgressPayload = ProgressPayload<"tool"> & {
  detailMode?: DetailMode;
};
type ItemProgressPayload = Omit<ProgressPayload<"item">, "itemKind"> & {
  kind?: string;
  detailMode?: DetailMode;
};
type CommandOutputProgressPayload = ProgressPayload<"command-output"> & {
  detailMode?: DetailMode;
};
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
    detailMode?: DetailMode,
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
      const { kind: itemKind, detailMode, ...input } = payload;
      params.onItem?.(payload);
      return pushEvent({ event: "item", ...input, itemKind }, detailMode);
    },
    pushApprovalEvent: (payload: ProgressPayload<"approval">) => {
      return payload.phase === "requested"
        ? pushEvent({ event: "approval", ...payload })
        : Promise.resolve(false);
    },
    pushCommandOutputEvent: (payload: CommandOutputProgressPayload) => {
      const { detailMode, ...input } = payload;
      return payload.phase === "end"
        ? pushEvent({ event: "command-output", ...input }, detailMode)
        : Promise.resolve(false);
    },
    pushPatchEvent: (payload: ProgressPayload<"patch">) => {
      return payload.phase === "end"
        ? pushEvent({ event: "patch", ...payload })
        : Promise.resolve(false);
    },
  };
}
