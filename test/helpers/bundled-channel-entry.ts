import { expect, it } from "vitest";

type BundledChannelEntry = {
  id: string;
  kind?: string;
  name: string;
};

type BundledChannelSetupEntry = {
  kind?: string;
  loadSetupPlugin?: unknown;
};

export function assertBundledChannelEntries(params: {
  entry: BundledChannelEntry;
  expectedId: string;
  expectedName: string;
  setupEntry: BundledChannelSetupEntry;
  channelMessage?: string;
  setupMessage?: string;
}) {
  it(
    params.channelMessage ?? "declares the channel plugin without importing the broad api barrel",
    () => {
      expect(params.entry.kind).toBe("bundled-channel-entry");
      expect(params.entry.id).toBe(params.expectedId);
      expect(params.entry.name).toBe(params.expectedName);
    },
  );

  it(
    params.setupMessage ?? "declares the setup plugin without importing the broad api barrel",
    () => {
      expect(params.setupEntry.kind).toBe("bundled-channel-setup-entry");
      expect(typeof params.setupEntry.loadSetupPlugin).toBe("function");
    },
  );
}
