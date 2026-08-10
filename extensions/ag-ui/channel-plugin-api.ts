// AG-UI channel public surface. The bundled-channel loader resolves the
// ChannelPlugin from this barrel (see index.ts `plugin` ref) without executing
// the rest of the plugin's runtime wiring.
export { aguiChannelPlugin } from "./src/channel.js";
