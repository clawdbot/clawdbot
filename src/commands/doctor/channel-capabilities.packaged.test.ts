// Packaged doctor capability tests cover generated catalog lookup without plugin runtime loading.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupTempDirs,
  makeTempDir as makeTempRepoRoot,
} from "../../../test/helpers/temp-dir.js";
import { writeJsonFile } from "../../../test/helpers/temp-repo.js";

const packageRootMock = vi.hoisted(() => ({ value: "" }));
const channelPluginMocks = vi.hoisted(() => ({
  getBundledChannelPlugin: vi.fn(() => undefined),
  getChannelPlugin: vi.fn(() => undefined),
}));

vi.mock("../../channels/plugins/bundled.js", () => ({
  getBundledChannelPlugin: channelPluginMocks.getBundledChannelPlugin,
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: channelPluginMocks.getChannelPlugin,
}));

vi.mock("../../plugins/bundled-dir.js", () => ({
  resolveBundledPluginsDir: () => undefined,
  resolveSourceCheckoutDependencyDiagnostic: () => null,
}));

vi.mock("../../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRootSync: () => packageRootMock.value,
  resolveOpenClawPackageRoot: async () => packageRootMock.value,
}));

import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { getDoctorChannelCapabilities } from "./channel-capabilities.js";

const tempDirs: string[] = [];

beforeEach(() => {
  const root = makeTempRepoRoot(tempDirs, "doctor-channel-packaged-");
  packageRootMock.value = root;
  writeJsonFile(path.join(root, "package.json"), { name: "openclaw" });
  writeJsonFile(path.join(root, "dist", "channel-catalog.json"), {
    entries: [
      {
        name: "@openclaw/discord",
        openclaw: {
          channel: {
            id: "discord",
            label: "Discord",
            doctorCapabilities: {
              dmAllowFromMode: "topOnly",
              groupModel: "route",
              groupAllowFromFallbackToAllowFrom: false,
              warnOnEmptyGroupSenderAllowlist: false,
            },
          },
        },
      },
    ],
  });
  clearPluginMetadataLifecycleCaches();
  channelPluginMocks.getBundledChannelPlugin.mockReset().mockReturnValue(undefined);
  channelPluginMocks.getChannelPlugin.mockReset().mockReturnValue(undefined);
});

afterEach(() => {
  packageRootMock.value = "";
  clearPluginMetadataLifecycleCaches();
  cleanupTempDirs(tempDirs);
  vi.restoreAllMocks();
});

describe("doctor channel capabilities in a packaged install", () => {
  it("reads Discord semantics from the generated catalog without loading a plugin", () => {
    expect(getDoctorChannelCapabilities("discord")).toEqual({
      dmAllowFromMode: "topOnly",
      groupModel: "route",
      groupAllowFromFallbackToAllowFrom: false,
      warnOnEmptyGroupSenderAllowlist: false,
    });
    expect(channelPluginMocks.getChannelPlugin).not.toHaveBeenCalled();
    expect(channelPluginMocks.getBundledChannelPlugin).not.toHaveBeenCalled();
  });
});
