// Control UI CSS hygiene: plain stylesheets plus css`` templates in Lit
// components (postcss-lit). Error-class rules only — oxfmt owns formatting.
export default {
  extends: "stylelint-config-recommended",
  rules: {
    // Cascade-order advice, not an error class; 400+ intentional hits in the
    // existing token/override cascade make it pure noise here.
    "no-descending-specificity": null,
    // `clip` survives only inside the standard sr-only fallback pattern.
    "property-no-deprecated": [true, { ignoreProperties: ["clip"] }],
    // `word-break: break-word` is deprecated but swapping it for overflow-wrap
    // changes min-content sizing in flex/grid text containers.
    "declaration-property-value-keyword-no-deprecated": [true, { ignoreKeywords: ["break-word"] }],
  },
  overrides: [
    {
      files: ["**/*.css"],
      rules: {
        "color-no-hex": true,
        // Control UI max-width breakpoints use one ladder: 400, 560, 640,
        // 768, 900, 1100, and 1320px. Round thresholds up to the next rung
        // so compact layouts engage before desktop layouts become cramped.
        "media-feature-name-value-allowed-list": {
          "max-width": ["400px", "560px", "640px", "768px", "900px", "1100px", "1320px", "932px"],
          "max-height": ["500px"],
          "min-width": ["769px", "933px", "1121px", "1400px", "1600px"],
        },
      },
    },
    {
      // Theme token definitions are the one source of stylesheet hex colors.
      files: ["../ui/src/styles/base.css"],
      rules: {
        "color-no-hex": null,
      },
    },
    {
      // Lobster sprite artwork owns a fixed illustration palette, not UI theme colors.
      files: ["../ui/src/styles/lobster-pet.css"],
      rules: {
        "color-no-hex": null,
      },
    },
    {
      files: ["**/*.ts"],
      customSyntax: "postcss-lit",
    },
  ],
};
