import type { ChannelDirectoryAdapter } from "../channel-contract.js";

type DirectorySurface = {
  listPeers: NonNullable<ChannelDirectoryAdapter["listPeers"]>;
  listGroups: NonNullable<ChannelDirectoryAdapter["listGroups"]>;
};

export function createDirectoryTestRuntime() {
  return {
    log: () => {},
    error: () => {},
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };
}

export function expectDirectorySurface(directory: unknown): DirectorySurface {
  if (!directory || typeof directory !== "object") {
    throw new Error("expected directory");
  }
  const { listPeers, listGroups } = directory as ChannelDirectoryAdapter;
  if (!listPeers) {
    throw new Error("expected listPeers");
  }
  if (!listGroups) {
    throw new Error("expected listGroups");
  }
  return {
    listPeers,
    listGroups,
  };
}
