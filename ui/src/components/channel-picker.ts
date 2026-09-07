import { nothing } from "lit";
import { renderChannelIcon } from "./channel-icon.ts";
import { renderPicker, type PickerOption, type PickerParams } from "./select-picker.ts";

export type ChannelPickerOption = PickerOption & {
  /** Neutral choices such as "last" or "all" are routing policy, not transports. */
  kind?: "channel" | "neutral";
};

export function renderChannelPicker(params: PickerParams<ChannelPickerOption>) {
  return renderPicker({
    ...params,
    className: "channel-picker",
    renderLeading: (option) =>
      option.kind === "neutral" ? nothing : renderChannelIcon(option.value, option.label, "picker"),
  });
}
