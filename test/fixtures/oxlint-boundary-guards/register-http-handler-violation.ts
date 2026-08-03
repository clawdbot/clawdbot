plugin.registerHttpHandler(() => {});
(plugin.registerHttpHandler as (handler: () => void) => void)(() => {});
plugin?.registerHttpHandler?.(() => {});
const register = plugin.registerHttpHandler;
const { registerHttpHandler } = plugin;
plugin["registerHttpHandler"](() => {});
(plugin.registerHttpHandler satisfies (handler: () => void) => void)(() => {});
