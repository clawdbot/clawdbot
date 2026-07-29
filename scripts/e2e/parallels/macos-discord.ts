// Macos Discord script supports OpenClaw repository automation.
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MacosGuest } from "./guest-transports.ts";
import { run, say, shellQuote, warn } from "./host-command.ts";

type DiscordSmokePhase = "fresh" | "upgrade";

interface MacosDiscordConfig {
  channelId: string;
  guildId: string;
  token: string;
}

export class MacosDiscordSmoke {
  constructor(
    private input: {
      config: MacosDiscordConfig;
      guest: MacosGuest;
      guestNode: string;
      guestOpenClaw: string;
      guestOpenClawEntry: string;
      runDir: string;
      vmName: string;
    },
  ) {}

  configure(): void {
    const guilds = JSON.stringify({
      [this.input.config.guildId]: {
        channels: {
          [this.input.config.channelId]: {
            enabled: true,
            requireMention: false,
          },
        },
      },
    });
    this.input.guest.sh(`set -eu
${this.input.guestNode} ${this.input.guestOpenClawEntry} config set channels.discord.token ${shellQuote(this.input.config.token)}
${this.input.guestNode} ${this.input.guestOpenClawEntry} config set channels.discord.enabled true
${this.input.guestNode} ${this.input.guestOpenClawEntry} config set channels.discord.groupPolicy allowlist
${this.input.guestNode} ${this.input.guestOpenClawEntry} config set channels.discord.guilds ${shellQuote(guilds)} --strict-json
${this.input.guestNode} ${this.input.guestOpenClawEntry} doctor --fix --yes --non-interactive
${this.input.guestNode} - <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const configPath = path.join(process.env.HOME || "", ".openclaw", "openclaw.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
config.plugins = config.plugins && typeof config.plugins === "object" ? config.plugins : {};
const allow = Array.isArray(config.plugins.allow) ? config.plugins.allow : [];
config.plugins.allow = Array.from(new Set([...allow, "discord"]));
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\\n");
JS
${this.input.guestNode} ${this.input.guestOpenClawEntry} plugins enable discord
${this.input.guestNode} ${this.input.guestOpenClawEntry} gateway restart
${this.input.guestNode} ${this.input.guestOpenClawEntry} channels status --probe --json`);
  }

  async runRoundtrip(phase: DiscordSmokePhase): Promise<void> {
    const nonce = randomUUID();
    const outboundNonce = `${phase}-out-${nonce}`;
    const inboundNonce = `${phase}-in-${nonce}`;
    const outboundLog = path.join(this.input.runDir, `${phase}.discord-send.json`);
    const sentIdFile = path.join(this.input.runDir, `${phase}.discord-sent-message-id`);
    const hostIdFile = path.join(this.input.runDir, `${phase}.discord-host-message-id`);
    const outbound = this.input.guest.exec([
      this.input.guestOpenClaw,
      "message",
      "send",
      "--channel",
      "discord",
      "--target",
      `channel:${this.input.config.channelId}`,
      "--message",
      `parallels-macos-smoke-outbound-${outboundNonce}`,
      "--silent",
      "--json",
    ]);
    await writeFile(outboundLog, `${outbound}\n`, "utf8");
    const sentId = this.discordMessageId(outbound);
    await writeFile(sentIdFile, `${sentId}\n`, "utf8");
    await this.waitForHostVisibility(outboundNonce, sentId);
    const hostId = await this.postDiscordMessage(`parallels-macos-smoke-inbound-${inboundNonce}`);
    await writeFile(hostIdFile, `${hostId}\n`, "utf8");
    this.waitForGuestReadback(inboundNonce);
  }

  async cleanupMessages(): Promise<void> {
    for (const name of [
      "fresh.discord-sent-message-id",
      "fresh.discord-host-message-id",
      "upgrade.discord-sent-message-id",
      "upgrade.discord-host-message-id",
    ]) {
      const filePath = path.join(this.input.runDir, name);
      const id = await readFile(filePath, "utf8").catch(() => "");
      if (id.trim()) {
        await this.discordApi(
          "DELETE",
          `/channels/${this.input.config.channelId}/messages/${id.trim()}`,
        ).catch(() => "");
      }
    }
  }

  stopVmAfterSuccessfulSmoke(freshDiscord: string, upgradeDiscord: string): void {
    if (freshDiscord !== "pass" && upgradeDiscord !== "pass") {
      return;
    }
    say(`Stop ${this.input.vmName} after successful Discord smoke`);
    const result = run("prlctl", ["stop", this.input.vmName], {
      check: false,
      quiet: true,
      timeoutMs: 120_000,
    });
    if (result.status !== 0) {
      warn(
        `failed to stop ${this.input.vmName} after successful Discord smoke (rc=${result.status})`,
      );
    }
  }

  private discordMessageId(payloadText: string): string {
    const payload = JSON.parse(payloadText) as {
      payload?: { messageId?: string; result?: { messageId?: string } };
    };
    const id = payload.payload?.messageId || payload.payload?.result?.messageId;
    if (!id) {
      throw new Error("messageId missing from send output");
    }
    return id;
  }

  private async discordApi(method: string, apiPath: string, payload?: unknown): Promise<string> {
    const args = [
      "-fsS",
      "--connect-timeout",
      "10",
      "--max-time",
      "30",
      "-X",
      method,
      "-H",
      `Authorization: Bot ${this.input.config.token}`,
      ...(payload == null
        ? []
        : ["-H", "Content-Type: application/json", "--data", JSON.stringify(payload)]),
      `https://discord.com/api/v10${apiPath}`,
    ];
    // Keep smoke phase deadlines enforceable even if curl itself fails to terminate promptly.
    return run("curl", args, { quiet: true, timeoutMs: 45_000 }).stdout;
  }

  private async waitForHostVisibility(nonce: string, messageId: string): Promise<void> {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const direct = await this.discordApi(
        "GET",
        `/channels/${this.input.config.channelId}/messages/${messageId}`,
      ).catch(() => "");
      if (direct.includes(nonce)) {
        return;
      }
      const recent = await this.discordApi(
        "GET",
        `/channels/${this.input.config.channelId}/messages?limit=20`,
      ).catch(() => "");
      if (recent.includes(nonce)) {
        return;
      }
      run("sleep", ["2"], { quiet: true });
    }
    throw new Error("Discord host visibility timed out");
  }

  private async postDiscordMessage(content: string): Promise<string> {
    const response = await this.discordApi(
      "POST",
      `/channels/${this.input.config.channelId}/messages`,
      {
        content,
        flags: 4096,
      },
    );
    const id = (JSON.parse(response) as { id?: string }).id;
    if (!id) {
      throw new Error("host Discord post missing message id");
    }
    return id;
  }

  private waitForGuestReadback(nonce: string): void {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const result = this.input.guest.run(
        [
          this.input.guestOpenClaw,
          "message",
          "read",
          "--channel",
          "discord",
          "--target",
          `channel:${this.input.config.channelId}`,
          "--limit",
          "20",
          "--json",
        ],
        { check: false },
      );
      if (result.status === 0 && result.stdout.includes(nonce)) {
        return;
      }
      run("sleep", ["3"], { quiet: true });
    }
    throw new Error("Discord guest readback timed out");
  }
}
