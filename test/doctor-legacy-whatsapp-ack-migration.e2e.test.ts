import fs from "node:fs/promises";
import { expect, it } from "vitest";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

it(
  "reports a legacy WhatsApp acknowledgement emoji kept by canonical config",
  { timeout: 180_000 },
  async () => {
    const instance = await createOpenClawTestInstance({ name: "doctor-whatsapp-ack" });
    try {
      const initialConfig = JSON.parse(await fs.readFile(instance.configPath, "utf8"));
      await fs.writeFile(
        instance.configPath,
        JSON.stringify({
          ...initialConfig,
          messages: { ackReaction: "🔥" },
          channels: {
            whatsapp: { ackReaction: { emoji: "✅", direct: true, group: "never" } },
          },
        }),
        "utf8",
      );

      const doctor = await instance.cli(
        ["doctor", "--fix", "--non-interactive", "--yes", "--no-workspace-suggestions"],
        { timeoutMs: 120_000 },
      );

      expect(doctor.code, `${doctor.stdout}\n${doctor.stderr}`).toBe(0);
      const output = `${doctor.stdout}\n${doctor.stderr}`.replaceAll("│", "").replace(/\s+/gu, " ");
      expect(output).toContain(
        'channels.whatsapp.ackReaction requested acknowledgement emoji "✅", but the final messages.ackReaction is "🔥". Review messages.ackReaction.',
      );
      const migrated = JSON.parse(await fs.readFile(instance.configPath, "utf8"));
      expect(migrated.messages).toMatchObject({
        ackReaction: "🔥",
        ackReactionScope: "direct",
      });
      expect(migrated.channels.whatsapp.ackReaction).toBeUndefined();
    } finally {
      await instance.cleanup();
    }
  },
);
