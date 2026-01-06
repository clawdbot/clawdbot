import { describe, expect, it } from "vitest";

import {
  applyConfigSnapshot,
  updateConfigFormValue,
  type ConfigState,
} from "./config";
import {
  defaultDiscordActions,
  defaultSlackActions,
  type DiscordForm,
  type IMessageForm,
  type SignalForm,
  type SlackForm,
  type TelegramForm,
} from "../ui-types";

const baseTelegramForm: TelegramForm = {
  token: "",
  requireMention: true,
  allowFrom: "",
  proxy: "",
  webhookUrl: "",
  webhookSecret: "",
  webhookPath: "",
};

const baseDiscordForm: DiscordForm = {
  enabled: true,
  token: "",
  dmEnabled: true,
  allowFrom: "",
  groupEnabled: false,
  groupChannels: "",
  mediaMaxMb: "",
  historyLimit: "",
  textChunkLimit: "",
  replyToMode: "off",
  guilds: [],
  actions: { ...defaultDiscordActions },
  slashEnabled: false,
  slashName: "",
  slashSessionPrefix: "",
  slashEphemeral: true,
};

const baseSlackForm: SlackForm = {
  enabled: true,
  botToken: "",
  appToken: "",
  dmEnabled: true,
  allowFrom: "",
  groupEnabled: false,
  groupChannels: "",
  mediaMaxMb: "",
  textChunkLimit: "",
  reactionNotifications: "own",
  reactionAllowlist: "",
  slashEnabled: false,
  slashName: "",
  slashSessionPrefix: "",
  slashEphemeral: true,
  actions: { ...defaultSlackActions },
  channels: [],
};

const baseSignalForm: SignalForm = {
  enabled: true,
  account: "",
  httpUrl: "",
  httpHost: "",
  httpPort: "",
  cliPath: "",
  autoStart: true,
  receiveMode: "",
  ignoreAttachments: false,
  ignoreStories: false,
  sendReadReceipts: false,
  allowFrom: "",
  mediaMaxMb: "",
};

const baseIMessageForm: IMessageForm = {
  enabled: true,
  cliPath: "",
  dbPath: "",
  service: "auto",
  region: "",
  allowFrom: "",
  includeAttachments: false,
  mediaMaxMb: "",
};

function createState(): ConfigState {
  return {
    client: null,
    connected: false,
    configLoading: false,
    configRaw: "",
    configValid: null,
    configIssues: [],
    configSaving: false,
    configSnapshot: null,
    configSchema: null,
    configSchemaVersion: null,
    configSchemaLoading: false,
    configUiHints: {},
    configForm: null,
    configFormDirty: false,
    configFormMode: "form",
    lastError: null,
    telegramForm: { ...baseTelegramForm },
    discordForm: { ...baseDiscordForm },
    slackForm: { ...baseSlackForm },
    signalForm: { ...baseSignalForm },
    imessageForm: { ...baseIMessageForm },
    telegramConfigStatus: null,
    discordConfigStatus: null,
    slackConfigStatus: null,
    signalConfigStatus: null,
    imessageConfigStatus: null,
  };
}

describe("applyConfigSnapshot", () => {
  it("handles missing slack config without throwing", () => {
    const state = createState();
    applyConfigSnapshot(state, {
      config: {
        telegram: {},
        discord: {},
        signal: {},
        imessage: {},
      },
      valid: true,
      issues: [],
      raw: "{}",
    });

    expect(state.slackForm.botToken).toBe("");
    expect(state.slackForm.actions).toEqual(defaultSlackActions);
  });
});

describe("updateConfigFormValue", () => {
  it("seeds from snapshot when form is null", () => {
    const state = createState();
    state.configSnapshot = {
      config: { telegram: { botToken: "t" }, gateway: { mode: "local" } },
      valid: true,
      issues: [],
      raw: "{}",
    };

    updateConfigFormValue(state, ["gateway", "port"], 18789);

    expect(state.configFormDirty).toBe(true);
    expect(state.configForm).toEqual({
      telegram: { botToken: "t" },
      gateway: { mode: "local", port: 18789 },
    });
  });
});
