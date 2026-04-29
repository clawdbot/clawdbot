import fs from "node:fs";

const raw = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const payload = raw.result ?? raw.data ?? raw;
const channel = process.argv[3];
const dump = () => JSON.stringify(raw, null, 2).slice(0, 4000);

const hasChannelMeta = Array.isArray(payload.channelMeta)
  ? payload.channelMeta.some((entry) => entry?.id === channel)
  : Boolean(payload.channelMeta?.[channel]);
if (!hasChannelMeta) {
  throw new Error(`missing channelMeta.${channel}\n${dump()}`);
}
if (!payload.channels || !payload.channels[channel]) {
  throw new Error(`missing channels.${channel}\n${dump()}`);
}
const accounts = payload.channelAccounts?.[channel];
if (!Array.isArray(accounts) || accounts.length === 0) {
  throw new Error(`missing channelAccounts.${channel}\n${dump()}`);
}

console.log(`${channel} channel plugin visible`);
