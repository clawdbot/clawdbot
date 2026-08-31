import type { AnyNode, Plugin, Rule } from "postcss";

function isHoverGuarded(rule: Rule): boolean {
  let ancestor: AnyNode | undefined = rule.parent;
  while (ancestor) {
    if (ancestor.type === "atrule" && ancestor.params.includes("hover:")) {
      return true;
    }
    ancestor = ancestor.parent;
  }
  return false;
}

export function controlUiHoverGuardPlugin(): Plugin {
  return {
    postcssPlugin: "control-ui-hover-guard",
    Rule(rule, { AtRule }) {
      if (!rule.selector.includes(":hover") || isHoverGuarded(rule)) {
        return;
      }

      const hoverSelectors = rule.selectors.filter((selector) => selector.includes(":hover"));
      const otherSelectors = rule.selectors.filter((selector) => !selector.includes(":hover"));
      const hoverRule = rule.clone();
      hoverRule.selectors = hoverSelectors;
      const guard = new AtRule({ name: "media", params: "(hover: hover)" });
      guard.append(hoverRule);

      if (otherSelectors.length === 0) {
        rule.replaceWith(guard);
        return;
      }

      rule.selectors = otherSelectors;
      rule.after(guard);
    },
  };
}
