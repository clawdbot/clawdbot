declare module "tokenjuice/openclaw" {
  export function createTokenjuiceOpenClawEmbeddedExtension(): Parameters<
    import("openclaw/plugin-sdk/plugin-entry").OpenClawPluginApi["registerEmbeddedExtensionFactory"]
  >[0];
}
