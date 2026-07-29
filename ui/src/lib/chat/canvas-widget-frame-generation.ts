// Capability rotation leaves this stable; lease start/stop bump it so keyed
// Canvas frames are recreated only at connection boundaries.
let generation = 0;

export function getCanvasWidgetFrameConnectionGeneration(): number {
  return generation;
}

export function bumpCanvasWidgetFrameConnectionGeneration(): void {
  generation += 1;
}
