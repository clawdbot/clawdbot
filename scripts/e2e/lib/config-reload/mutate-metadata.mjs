import fs from "node:fs";

const configPath = process.env.OPENCLAW_CONFIG_PATH;
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
config.gateway.channelHealthCheckMinutes = 2;
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
