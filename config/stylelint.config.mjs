// Control UI CSS hygiene: plain stylesheets plus css`` templates in Lit
// components (postcss-lit). Error-class rules only — oxfmt owns formatting.
export default {
  extends: "stylelint-config-recommended",
  rules: {
    // Cascade-order advice, not an error class; 400+ intentional hits in the
    // existing token/override cascade make it pure noise here.
    "no-descending-specificity": null,
    // 17 pre-existing duplicates; merging them reorders the cascade and needs
    // per-site visual proof. Tighten in a follow-up, keep new code honest via
    // review until then.
    "no-duplicate-selectors": null,
    // `clip` survives only inside the standard sr-only fallback pattern.
    "property-no-deprecated": [true, { ignoreProperties: ["clip"] }],
    // `word-break: break-word` is deprecated but swapping it for overflow-wrap
    // changes min-content sizing in flex/grid text containers.
    "declaration-property-value-keyword-no-deprecated": [true, { ignoreKeywords: ["break-word"] }],
  },
  overrides: [
    {
      files: ["**/*.ts"],
      customSyntax: "postcss-lit",
    },
  ],
};
