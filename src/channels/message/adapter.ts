import type {
  ChannelMessageAdapter,
  ChannelMessageAdapterShape,
  ChannelMessageReceiveAdapterShape,
} from "./types.js";

const defaultManualReceiveAdapter = {
  defaultAckPolicy: "manual",
  supportedAckPolicies: ["manual"],
} as const satisfies ChannelMessageReceiveAdapterShape;

type ChannelMessageAdapterWithDefaultReceive<TAdapter extends ChannelMessageAdapterShape> =
  TAdapter & {
    receive: TAdapter["receive"] extends undefined
      ? typeof defaultManualReceiveAdapter
      : NonNullable<TAdapter["receive"]>;
  };

export function defineChannelMessageAdapter<const TAdapter extends ChannelMessageAdapterShape>(
  adapter: TAdapter,
): ChannelMessageAdapter<ChannelMessageAdapterWithDefaultReceive<TAdapter>> {
  return {
    ...adapter,
    receive: adapter.receive ?? defaultManualReceiveAdapter,
  } as ChannelMessageAdapter<ChannelMessageAdapterWithDefaultReceive<TAdapter>>;
}
