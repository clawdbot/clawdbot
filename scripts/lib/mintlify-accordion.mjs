export const MINTLIFY_ACCORDION_INDENT_MESSAGE =
  "Accordion closing tag is indented deeper than its opening tag; Mintlify can parse following markdown as nested content.";

function visitAccordionIndentation(raw, onMisindentedClose) {
  const lines = raw.split(/\r?\n/u);
  const accordionStack = [];
  let inCodeFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*(```|~~~)/u.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) {
      continue;
    }

    const openAccordion = line.match(/^(\s*)<Accordion\b/u);
    if (openAccordion) {
      accordionStack.push({
        indent: openAccordion[1].length,
        hasOutdentedListItem: false,
      });
      continue;
    }

    const listItem = line.match(/^(\s*)[-*+]\s+/u);
    if (listItem) {
      for (const accordion of accordionStack) {
        if (listItem[1].length < accordion.indent) {
          accordion.hasOutdentedListItem = true;
        }
      }
    }

    const closeAccordion = line.match(/^(\s*)<\/Accordion>/u);
    if (!closeAccordion) {
      continue;
    }

    const opening = accordionStack.pop();
    if (opening && opening.hasOutdentedListItem && closeAccordion[1].length > opening.indent) {
      onMisindentedClose({ closeAccordion, index, line, lines, opening });
    }
  }

  return lines;
}

export function checkMintlifyAccordionIndentation(raw) {
  const errors = [];
  visitAccordionIndentation(raw, ({ closeAccordion, index }) => {
    errors.push({
      line: index + 1,
      column: closeAccordion[1].length + 1,
      message: MINTLIFY_ACCORDION_INDENT_MESSAGE,
    });
  });
  return errors;
}

export function repairMintlifyAccordionIndentation(raw) {
  let changed = false;
  const lines = visitAccordionIndentation(
    raw,
    ({ closeAccordion, index, line, lines, opening }) => {
      lines[index] = `${" ".repeat(opening.indent)}${line.slice(closeAccordion[1].length)}`;
      changed = true;
    },
  );
  return changed ? lines.join("\n") : raw;
}
