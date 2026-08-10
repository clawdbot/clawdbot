// Setup-safe channel surface, loaded on cold paths (status, channels list,
// setup) and during channel-activation planning without pulling the channel
// runtime. AG-UI's channel plugin is already light — meta/capabilities/config/
// pairing/gateway with no transport clients, listeners, or subprocess launchers
// — so it doubles as the setup plugin.
export { aguiChannelPlugin as aguiSetupPlugin } from "./src/channel.js";
