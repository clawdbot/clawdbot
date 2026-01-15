import { describe, expect, it, vi } from "vitest";

import {
  applyConfigSnapshot,
  applyConfig,
  runUpdate,
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
  groupsWildcardEnabled: false,
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
    applySessionKey: "main",
    configLoading: false,
    configRaw: "",
    configValid: null,
    configIssues: [],
    configSaving: false,
    configApplying: false,
    updateRunning: false,
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
        channels: {
          telegram: {},
          discord: {},
          signal: {},
          imessage: {},
        },
      },
      valid: true,
      issues: [],
      raw: "{}",
    });

    expect(state.slackForm.botToken).toBe("");
    expect(state.slackForm.actions).toEqual(defaultSlackActions);
  });

  it("does not clobber form edits while dirty", () => {
    const state = createState();
    state.configFormMode = "form";
    state.configFormDirty = true;
    state.configForm = { gateway: { mode: "local", port: 18789 } };
    state.configRaw = "{\n}\n";

    applyConfigSnapshot(state, {
      config: { gateway: { mode: "remote", port: 9999 } },
      valid: true,
      issues: [],
      raw: "{\n  \"gateway\": { \"mode\": \"remote\", \"port\": 9999 }\n}\n",
    });

    expect(state.configRaw).toBe(
      "{\n  \"gateway\": {\n    \"mode\": \"local\",\n    \"port\": 18789\n  }\n}\n",
    );
  });
});

describe("updateConfigFormValue", () => {
  it("seeds from snapshot when form is null", () => {
    const state = createState();
    state.configSnapshot = {
      config: { channels: { telegram: { botToken: "t" } }, gateway: { mode: "local" } },
      valid: true,
      issues: [],
      raw: "{}",
    };

    updateConfigFormValue(state, ["gateway", "port"], 18789);

    expect(state.configFormDirty).toBe(true);
    expect(state.configForm).toEqual({
      channels: { telegram: { botToken: "t" } },
      gateway: { mode: "local", port: 18789 },
    });
  });

  it("keeps raw in sync while editing the form", () => {
    const state = createState();
    state.configSnapshot = {
      config: { gateway: { mode: "local" } },
      valid: true,
      issues: [],
      raw: "{\n}\n",
    };

    updateConfigFormValue(state, ["gateway", "port"], 18789);

    expect(state.configRaw).toBe(
      "{\n  \"gateway\": {\n    \"mode\": \"local\",\n    \"port\": 18789\n  }\n}\n",
    );
  });
});

describe("applyConfig", () => {
  it("sends config.apply with raw and session key", async () => {
    const request = vi.fn().mockResolvedValue({});
    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigState["client"];
    state.applySessionKey = "agent:main:whatsapp:dm:+15555550123";
    state.configFormMode = "raw";
    state.configRaw = "{\n  agent: { workspace: \"~/clawd\" }\n}\n";
    state.configSnapshot = {
      hash: "hash-123",
    };

    await applyConfig(state);

    expect(request).toHaveBeenCalledWith("config.apply", {
      raw: "{\n  agent: { workspace: \"~/clawd\" }\n}\n",
      baseHash: "hash-123",
      sessionKey: "agent:main:whatsapp:dm:+15555550123",
    });
  });
});

describe("runUpdate", () => {
  it("sends update.run with session key", async () => {
    const request = vi.fn().mockResolvedValue({});
    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigState["client"];
    state.applySessionKey = "agent:main:whatsapp:dm:+15555550123";

    await runUpdate(state);

    expect(request).toHaveBeenCalledWith("update.run", {
      sessionKey: "agent:main:whatsapp:dm:+15555550123",
    });
  });
});
