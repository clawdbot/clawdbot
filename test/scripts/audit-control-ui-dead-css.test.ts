import { describe, expect, it } from "vitest";
import { collectControlUiClassReferences } from "../../scripts/audit-control-ui-dead-css.mts";

describe("Control UI dead-CSS dynamic stem detection", () => {
  it.each([
    [
      "status template expression",
      "const value = `status-dot--${approval.status}`;",
      "status-dot--",
    ],
    [
      "badge Lit template",
      'html`<span class="insight-badge--${badgeClass}"></span>`;',
      "insight-badge--",
    ],
    ["palette string concatenation", 'const value = "palette-" + palette.id;', "palette-"],
    ["lobster state template", "const value = `lobster-pet--act-${act}`;", "lobster-pet--act-"],
    [
      "ternary-headed template first branch",
      'const value = `${channels ? "channels-wizard" : "wizard-step"}__${name}`;',
      "channels-wizard__",
    ],
    [
      "ternary-headed template second branch",
      'const value = `${channels ? "channels-wizard" : "wizard-step"}__${name}`;',
      "wizard-step__",
    ],
  ])("recognizes a %s stem", (_label, source, expectedStem) => {
    expect(collectControlUiClassReferences(source).stems).toContain(expectedStem);
  });
});
