/** Read the native control carrying the Lit listener, including bubbled form key events. */
export function libraryEventControl<T extends HTMLElement>(event: Event, control: new () => T): T {
  if (!(event.currentTarget instanceof control)) {
    throw new TypeError(`Skill library listener requires ${control.name}.`);
  }
  return event.currentTarget;
}
