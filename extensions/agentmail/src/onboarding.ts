import { AgentMailClient } from "agentmail";
import type {
  ChannelOnboardingAdapter,
  MoltbotConfig,
} from "clawdbot/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "clawdbot/plugin-sdk";

import {
  resolveAgentMailAccount,
  resolveCredentials,
  resolveDefaultAgentMailAccountId,
} from "./accounts.js";
import type { AgentMailConfig, CoreConfig } from "./utils.js";

const channel = "agentmail" as const;
const DEFAULT_DOMAIN = "agentmail.to";

/** Parses input into username and domain. Supports "user" or "user@domain". */
export function parseInboxInput(input: string): {
  username: string;
  domain: string;
} {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.includes("@")) {
    const [username, domain] = trimmed.split("@");
    return { username, domain };
  }
  return { username: trimmed, domain: DEFAULT_DOMAIN };
}

/** Creates a new inbox via AgentMail API. */
async function createInbox(
  client: AgentMailClient,
  username: string,
  domain: string,
  displayName?: string
): Promise<string> {
  const inbox = await client.inboxes.create({
    username,
    domain,
    displayName,
  });
  return inbox.inboxId; // inboxId is the email address
}

/** Lists existing inboxes for the user. */
async function listInboxes(client: AgentMailClient): Promise<string[]> {
  const response = await client.inboxes.list();
  return response.inboxes.map((i) => i.inboxId);
}

/** Helper to build config with agentmail channel updates. */
export function updateAgentMailConfig(
  cfg: MoltbotConfig,
  updates: Partial<AgentMailConfig>
): MoltbotConfig {
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const agentmail = (channels.agentmail ?? {}) as AgentMailConfig;
  return {
    ...cfg,
    channels: {
      ...channels,
      agentmail: {
        ...agentmail,
        ...updates,
      },
    },
  } as MoltbotConfig;
}

export const agentmailOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,

  getStatus: async ({ cfg }) => {
    const { apiKey, inboxId } = resolveCredentials(cfg as CoreConfig);
    const configured = Boolean(apiKey && inboxId);
    return {
      channel,
      configured,
      statusLines: [
        `AgentMail: ${configured ? `configured (${inboxId})` : "needs token"}`,
      ],
      selectionHint: configured ? "configured" : "requires AgentMail account",
      quickstartScore: configured ? 1 : 5,
    };
  },

  configure: async ({ cfg, prompter, accountOverrides }) => {
    const defaultAccountId = resolveDefaultAgentMailAccountId(
      cfg as CoreConfig
    );
    const accountId = accountOverrides.agentmail
      ? normalizeAccountId(accountOverrides.agentmail)
      : defaultAccountId;

    let next = cfg as MoltbotConfig;
    const account = resolveAgentMailAccount({
      cfg: next as CoreConfig,
      accountId,
    });
    const { apiKey, inboxId } = resolveCredentials(next as CoreConfig);
    const configured = Boolean(apiKey && inboxId);

    const canUseEnv =
      accountId === DEFAULT_ACCOUNT_ID &&
      Boolean(process.env.AGENTMAIL_TOKEN?.trim());

    // If env var token is available and not already configured, offer to use it
    if (canUseEnv && !account.configured) {
      const useEnv = await prompter.confirm({
        message: "AGENTMAIL_TOKEN detected. Use env var?",
        initialValue: true,
      });
      if (useEnv) {
        const envToken = process.env.AGENTMAIL_TOKEN!.trim();
        const client = new AgentMailClient({ apiKey: envToken });
        const emailAddress = await selectOrCreateInbox(client, prompter);

        return {
          cfg: updateAgentMailConfig(next, { enabled: true, emailAddress }),
        };
      }
    }

    // If already configured, ask to keep
    if (configured) {
      const keep = await prompter.confirm({
        message: `AgentMail already configured (${inboxId}). Keep current settings?`,
        initialValue: true,
      });
      if (keep) {
        return { cfg: next };
      }
    }

    // Show help
    await prompter.note(
      [
        "You'll need an AgentMail API token from https://agentmail.to",
        "",
        "We'll help you create an inbox after you enter your token.",
      ].join("\n"),
      "AgentMail Setup"
    );

    // Prompt for token
    const token = String(
      await prompter.text({
        message: "AgentMail API token",
        placeholder: "am_...",
        validate: (v) => (v?.trim() ? undefined : "Required"),
      })
    ).trim();

    // Create client and select/create inbox
    const client = new AgentMailClient({ apiKey: token });
    const emailAddress = await selectOrCreateInbox(client, prompter);

    // Apply config
    next = updateAgentMailConfig(next, { enabled: true, token, emailAddress });

    // Webhook configuration
    const DEFAULT_WEBHOOK_PATH = "/webhooks/agentmail";

    // Ask if gateway has a public URL
    const hasPublicUrl = await prompter.confirm({
      message:
        "Does your gateway have a public URL? (for automatic webhook setup)",
      initialValue: false,
    });

    let webhookUrl: string | undefined;
    let webhookPath = DEFAULT_WEBHOOK_PATH;

    if (hasPublicUrl) {
      // Get the public base URL
      const baseUrl = String(
        await prompter.text({
          message: "Gateway public URL",
          placeholder: "https://my-gateway.ngrok.io",
          validate: (v) => {
            const trimmed = v?.trim();
            if (!trimmed) return "Required";
            if (
              !trimmed.startsWith("http://") &&
              !trimmed.startsWith("https://")
            ) {
              return "Must start with http:// or https://";
            }
            return undefined;
          },
        })
      )
        .trim()
        .replace(/\/+$/, ""); // Remove trailing slashes

      // Ask for webhook path
      const customPath = await prompter.confirm({
        message: `Customize webhook path? (default: ${DEFAULT_WEBHOOK_PATH})`,
        initialValue: false,
      });

      if (customPath) {
        const pathInput = String(
          await prompter.text({
            message: "Webhook path",
            placeholder: DEFAULT_WEBHOOK_PATH,
          })
        ).trim();

        if (pathInput) {
          webhookPath = pathInput.startsWith("/") ? pathInput : `/${pathInput}`;
        }
      }

      webhookUrl = baseUrl;

      // Auto-register webhook with AgentMail
      try {
        await client.webhooks.create({
          url: `${baseUrl}${webhookPath}`,
          eventTypes: ["message.received"],
          clientId: `moltbot-${emailAddress}`, // Idempotent per inbox
        });
        await prompter.note(
          `Webhook registered: ${baseUrl}${webhookPath}`,
          "Webhook Created"
        );
      } catch (err) {
        // Webhook may already exist or API error - show warning but continue
        await prompter.note(
          [
            `Could not auto-register webhook: ${String(err)}`,
            "",
            "You may need to configure it manually in the AgentMail dashboard:",
            `  URL: ${baseUrl}${webhookPath}`,
            "  Event: message.received",
          ].join("\n"),
          "Webhook Warning"
        );
      }
    } else {
      // No public URL - ask for path only and show manual instructions
      const customPath = await prompter.confirm({
        message: `Customize webhook path? (default: ${DEFAULT_WEBHOOK_PATH})`,
        initialValue: false,
      });

      if (customPath) {
        const pathInput = String(
          await prompter.text({
            message: "Webhook path",
            placeholder: DEFAULT_WEBHOOK_PATH,
          })
        ).trim();

        if (pathInput) {
          webhookPath = pathInput.startsWith("/") ? pathInput : `/${pathInput}`;
        }
      }
    }

    // Save webhook config
    next = updateAgentMailConfig(next, { webhookUrl, webhookPath });

    // Ask about allowFrom
    const addAllowFrom = await prompter.confirm({
      message: "Add senders to allowFrom? (Empty = allow all)",
      initialValue: false,
    });

    if (addAllowFrom) {
      const entry = String(
        await prompter.text({
          message:
            "Email or domain to allow (e.g., user@example.com or example.com)",
        })
      ).trim();

      if (entry) {
        const existing =
          (next as CoreConfig).channels?.agentmail?.allowFrom ?? [];
        next = updateAgentMailConfig(next, { allowFrom: [...existing, entry] });
      }
    }

    // Show manual webhook instructions only if we didn't auto-register
    if (!webhookUrl) {
      await prompter.note(
        [
          "Configure the webhook in your AgentMail dashboard:",
          `  URL: https://your-gateway${webhookPath}`,
          "  Event: message.received",
          "",
          "The gateway must be publicly accessible for webhooks to work.",
          "Without this, Moltbot won't receive incoming emails.",
        ].join("\n"),
        "Webhook Setup Required"
      );
    }

    return { cfg: next };
  },
};

type Prompter = Parameters<
  ChannelOnboardingAdapter["configure"]
>[0]["prompter"];

/** Prompts user to select an existing inbox or create a new one. */
async function selectOrCreateInbox(
  client: AgentMailClient,
  prompter: Prompter
): Promise<string> {
  // Check for existing inboxes
  let existingInboxes: string[] = [];
  try {
    existingInboxes = await listInboxes(client);
  } catch {
    // API error - proceed with create flow
  }

  if (existingInboxes.length > 0) {
    const choices = [
      ...existingInboxes.map((email) => ({ value: email, label: email })),
      { value: "__create__", label: "Create a new inbox" },
    ];

    const selection = await prompter.select({
      message: "Select an inbox or create a new one",
      options: choices,
    });

    if (selection !== "__create__") {
      return selection as string;
    }
  }

  return promptForNewInbox(client, prompter);
}

/** Prompts for inbox address and creates it, with retry on conflict. */
async function promptForNewInbox(
  client: AgentMailClient,
  prompter: Prompter
): Promise<string> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const input = String(
      await prompter.text({
        message: "Inbox address (username or full email)",
        placeholder: `my-agent or my-agent@${DEFAULT_DOMAIN}`,
        validate: (v) => {
          if (!v?.trim()) return "Required";
          const { username } = parseInboxInput(v);
          if (!/^[a-z0-9][a-z0-9._-]*[a-z0-9]$|^[a-z0-9]$/.test(username)) {
            return "Username must use lowercase letters, numbers, dots, underscores, or hyphens";
          }
          return undefined;
        },
      })
    ).trim();

    const { username, domain } = parseInboxInput(input);
    const targetEmail = `${username}@${domain}`;

    const displayName =
      String(
        await prompter.text({
          message: "Display name (optional)",
          placeholder: "My Agent",
        })
      ).trim() || undefined;

    try {
      const emailAddress = await createInbox(
        client,
        username,
        domain,
        displayName
      );
      await prompter.note(`Your new inbox: ${emailAddress}`, "Inbox Created");
      return emailAddress;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isConflict =
        message.toLowerCase().includes("already") ||
        message.toLowerCase().includes("taken") ||
        message.toLowerCase().includes("exists") ||
        message.includes("409");

      if (isConflict) {
        await prompter.note(
          `${targetEmail} is already taken. Please try a different address.`,
          "Address Unavailable"
        );
        continue;
      }

      throw new Error(`Failed to create inbox: ${message}`);
    }
  }
}
