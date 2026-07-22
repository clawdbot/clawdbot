export default {
  clean: true,
  dts: true,
  entry: [
    "src/index.ts",
    "src/catalog.ts",
    "src/context.ts",
    "src/locale-registry.ts",
  ],
  fixedExtension: false,
  format: "esm",
  outDir: "dist",
  outExtensions: () => ({ js: ".mjs", dts: ".d.mts" }),
  platform: "neutral",
};
