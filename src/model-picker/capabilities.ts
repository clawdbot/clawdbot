import type { ChannelPresentationCapabilities } from "../channels/plugins/outbound.types.js";

export type ModelPickerCapabilityProfile = {
  presentation: ChannelPresentationCapabilities;
  callback: {
    limit: number;
    unit: "utf8-bytes" | "utf16-units";
  };
  response: {
    supportsEphemeral: boolean;
    supportsEdit: boolean;
    supportsReplace: boolean;
  };
};
