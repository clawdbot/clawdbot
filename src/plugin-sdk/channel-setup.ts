// Channel setup contracts expose setup wizard hooks and account config writes to plugins.
import type { ChannelSetupWizard } from "../channels/plugins/setup-wizard-types.js";
import type { ChannelSetupAdapter } from "../channels/plugins/types.adapters.js";
export { defineChannelSetupContract } from "../channels/plugins/setup-contract.js";
import {
  createOptionalChannelSetupAdapter,
  createOptionalChannelSetupWizard,
} from "./optional-channel-setup.js";

export type { ChannelSetupAdapter } from "../channels/plugins/types.adapters.js";
export type { ChannelSetupInput } from "../channels/plugins/setup-input.js";
export type { ChannelSetupDmPolicy, ChannelSetupWizard } from "./setup.js";
export {
  DEFAULT_ACCOUNT_ID,
  baseUrlTextInput,
  createTopLevelChannelDmPolicy,
  defineTokenCredential,
  formatDocsLink,
  setSetupChannelEnabled,
  splitSetupEntries,
} from "./setup.js";

/** Metadata used to advertise an optional channel plugin during setup flows. */
type OptionalChannelSetupParams = {
  /** Channel id shown in setup status and wizard routing. */
  channel: string;
  /** Human-readable plugin name used in install guidance. */
  label: string;
  /** Package spec operators should install to enable the optional channel. */
  npmSpec?: string;
  /** Docs path linked from setup validation and wizard hints. */
  docsPath?: string;
};

/** Paired setup adapter + setup wizard for channels that may not be installed yet. */
export type OptionalChannelSetupSurface = {
  /** Adapter that fails validation with install guidance until the plugin is installed. */
  setupAdapter: ChannelSetupAdapter;
  /** Wizard status/finalize surface that points operators to the missing plugin. */
  setupWizard: ChannelSetupWizard;
};

export {
  createOptionalChannelSetupAdapter,
  createOptionalChannelSetupWizard,
} from "./optional-channel-setup.js";

/** Build both optional setup surfaces from one metadata object. */
export function createOptionalChannelSetupSurface(
  /** Optional plugin metadata shared by the adapter and wizard. */
  params: OptionalChannelSetupParams,
): OptionalChannelSetupSurface {
  return {
    setupAdapter: createOptionalChannelSetupAdapter(params),
    setupWizard: createOptionalChannelSetupWizard(params),
  };
}
