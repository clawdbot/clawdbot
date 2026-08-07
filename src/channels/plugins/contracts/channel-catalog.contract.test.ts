// Channel catalog contract tests cover bundled and registry-backed channel catalog invariants.
import fs from "node:fs";
import path from "node:path";
import { isPrereleaseSemverVersion } from "../../../infra/npm-registry-spec.js";
import {
  describeBundledMetadataOnlyChannelCatalogContract,
  describeChannelCatalogEntryContract,
  describeOfficialFallbackChannelCatalogContract,
} from "./test-helpers/channel-catalog-contract.js";

describeChannelCatalogEntryContract({
  channelId: "msteams",
  npmSpec: "@openclaw/msteams",
  alias: "teams",
});

const whatsappMeta = {
  id: "whatsapp",
  label: "WhatsApp",
  selectionLabel: "WhatsApp (QR link)",
  detailLabel: "WhatsApp Web",
  docsPath: "/channels/whatsapp",
  blurb: "works with your own number; recommend a separate phone + eSIM.",
};

const whatsappPackageJson = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "extensions", "whatsapp", "package.json"), "utf8"),
) as {
  name?: string;
  version?: string;
  openclaw?: { install?: { npmSpec?: string } };
};
const whatsappNpmSpec = whatsappPackageJson.openclaw?.install?.npmSpec ?? whatsappPackageJson.name;
const whatsappVersion = whatsappPackageJson.version;
if (!whatsappNpmSpec || !whatsappVersion) {
  throw new Error("missing package metadata for whatsapp");
}
const whatsappOfficialFallbackNpmSpec = isPrereleaseSemverVersion(whatsappVersion)
  ? `${whatsappNpmSpec}@${whatsappVersion}`
  : whatsappNpmSpec;

describeBundledMetadataOnlyChannelCatalogContract({
  pluginId: "whatsapp",
  packageName: "@openclaw/whatsapp",
  npmSpec: "@openclaw/whatsapp",
  meta: whatsappMeta,
  defaultChoice: "npm",
});

describeOfficialFallbackChannelCatalogContract({
  channelId: "whatsapp",
  npmSpec: whatsappOfficialFallbackNpmSpec,
  meta: whatsappMeta,
  packageName: "@openclaw/whatsapp",
  pluginId: "whatsapp",
  externalNpmSpec: "@vendor/whatsapp-fork",
  externalLabel: "WhatsApp Fork",
});

describeChannelCatalogEntryContract({
  channelId: "wecom",
  npmSpec: "@wecom/wecom-openclaw-plugin@2026.5.7",
  alias: "wework",
});

describeChannelCatalogEntryContract({
  channelId: "yuanbao",
  npmSpec: "openclaw-plugin-yuanbao@2.15.0",
  alias: "yb",
});

describeChannelCatalogEntryContract({
  channelId: "openclaw-zaloclawbot",
  npmSpec: "@zalo-platforms/openclaw-zaloclawbot@0.1.4",
  alias: "zaloclawbot",
});
