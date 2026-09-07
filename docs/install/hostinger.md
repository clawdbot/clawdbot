---
summary: "Host OpenClaw on Hostinger"
read_when:
  - Setting up OpenClaw on Hostinger
  - Looking for a managed VPS for OpenClaw
  - Using Hostinger 1-Click OpenClaw
title: "Hostinger"
---

Run a persistent OpenClaw Gateway on [Hostinger](https://www.hostinger.com/openclaw), either as a **1-Click** managed deployment or as a **VPS** install you administer yourself.

## Prerequisites

- Hostinger account ([signup](https://www.hostinger.com/openclaw))
- About 5-10 minutes

## Option A: 1-Click OpenClaw

Hostinger handles infrastructure, Docker, and automatic updates. Fastest path to a running instance.

<Steps>
  <Step title="Purchase and launch">
    1. From the [Hostinger OpenClaw page](https://www.hostinger.com/openclaw), choose a Managed OpenClaw plan and complete checkout.

    <Note>
    During checkout you can select **Ready-to-Use AI** credits that are pre-purchased and integrated instantly inside OpenClaw -- no external accounts or API keys from other providers needed. You can start chatting right away. Alternatively, provide your own key from Anthropic, OpenAI, Google Gemini, or xAI during setup.
    </Note>

  </Step>

  <Step title="Select a messaging channel">
    Choose one or more channels to connect:

    - **WhatsApp** -- scan the QR code shown in the setup wizard.
    - **Telegram** -- paste the bot token from [BotFather](https://t.me/BotFather).

  </Step>

  <Step title="Complete installation">
    Click **Finish** to deploy the instance. Once ready, access the OpenClaw dashboard from **OpenClaw Overview** in hPanel.
  </Step>

</Steps>

## Option B: OpenClaw on VPS

More control over the server. Hostinger deploys OpenClaw via Docker on your VPS; you manage it through the **Docker Manager** in hPanel.

<Steps>
  <Step title="Purchase a VPS">
    1. From the [Hostinger OpenClaw page](https://www.hostinger.com/openclaw), choose an OpenClaw on VPS plan and complete checkout.

    <Note>
    You can select **Ready-to-Use AI** credits during checkout -- these are pre-purchased and integrated instantly inside OpenClaw, so you can start chatting without any external accounts or API keys from other providers.
    </Note>

  </Step>

  <Step title="Configure OpenClaw">
    Once the VPS is provisioned, fill in the configuration fields:

    - **Gateway token** -- auto-generated; save it for later use.
    - **WhatsApp number** -- your number with country code (optional).
    - **Telegram bot token** -- from [BotFather](https://t.me/BotFather) (optional).
    - **API keys** -- only needed if you did not select Ready-to-Use AI credits during checkout.

  </Step>

  <Step title="Start OpenClaw">
    Click **Deploy**. Once running, open the OpenClaw dashboard from the hPanel by clicking on **Open**.
  </Step>

</Steps>

Logs, restarts, and updates run from the Docker Manager interface in hPanel. To update, press **Update** in Docker Manager to pull the latest image.

## Verify your setup

Send "Hi" to your assistant on the channel you connected. OpenClaw replies and walks you through initial preferences.

## Troubleshooting

**Dashboard not loading** -- Wait a few minutes for the container to finish provisioning, then check the Docker Manager logs in hPanel.

**Docker container keeps restarting** -- Open Docker Manager logs and look for configuration errors (missing tokens, invalid API keys).

**Telegram bot not responding** -- If DM pairing is required, an unknown sender gets a short pairing code instead of a reply. Approve it from the OpenClaw dashboard chat, or with `openclaw pairing approve telegram <CODE>` if you have shell access to the container. See [Pairing](/channels/pairing).

## Next steps

- [Channels](/channels) -- connect Telegram, WhatsApp, Discord, and more
- [Gateway configuration](/gateway/configuration) -- all config options

## Related

- [Install overview](/install)
- [VPS hosting](/vps)
- [DigitalOcean](/install/digitalocean)
