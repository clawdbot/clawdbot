export function readResponsesOutputIndex(event: object): number | undefined {
  const outputIndex = (event as { output_index?: unknown }).output_index;
  return typeof outputIndex === "number" && Number.isInteger(outputIndex) && outputIndex >= 0
    ? outputIndex
    : undefined;
}

export function createResponsesOutputSlotTracker<TSlot extends { type: string }>() {
  const indexed = new Map<number, TSlot>();
  let unindexed: TSlot | undefined;
  return {
    register(event: object, slot: TSlot): void {
      const outputIndex = readResponsesOutputIndex(event);
      if (outputIndex === undefined) {
        if (unindexed) {
          throw new Error("Responses stream added overlapping unindexed output items");
        }
        unindexed = slot;
        return;
      }
      if (indexed.has(outputIndex)) {
        throw new Error(`Responses stream reused active output index ${outputIndex}`);
      }
      indexed.set(outputIndex, slot);
    },
    resolve<TType extends TSlot["type"]>(
      event: object,
      type: TType,
    ): Extract<TSlot, { type: TType }> | undefined {
      const outputIndex = readResponsesOutputIndex(event);
      let slot = outputIndex === undefined ? unindexed : indexed.get(outputIndex);
      if (outputIndex === undefined && !slot) {
        const matches = [...indexed.values()].filter((candidate) => candidate.type === type);
        slot = matches.length === 1 ? matches[0] : undefined;
      }
      return slot?.type === type ? (slot as Extract<TSlot, { type: TType }>) : undefined;
    },
    get(event: object): TSlot | undefined {
      const outputIndex = readResponsesOutputIndex(event);
      return outputIndex === undefined ? unindexed : indexed.get(outputIndex);
    },
    values(): TSlot[] {
      return [...new Set([...indexed.values(), ...(unindexed ? [unindexed] : [])])];
    },
    forget(slot: TSlot): void {
      if (unindexed === slot) {
        unindexed = undefined;
      }
      for (const [outputIndex, candidate] of indexed) {
        if (candidate === slot) {
          indexed.delete(outputIndex);
        }
      }
    },
  };
}
