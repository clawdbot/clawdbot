type GatewayResident<
  TStart extends () => unknown = () => unknown,
  TStop extends () => unknown = () => unknown,
> = {
  name: string;
  start: TStart;
  stop: TStop;
};

export type GatewayResidentRegistry = {
  register: <TStart extends () => unknown, TStop extends () => unknown>(
    resident: GatewayResident<TStart, TStop>,
  ) => GatewayResident<TStart, TStop>;
  list: () => readonly GatewayResident[];
};

/** Records resident lifecycle owners without changing when callers start or stop them. */
export function createGatewayResidentRegistry(): GatewayResidentRegistry {
  const residents: GatewayResident[] = [];
  const names = new Set<string>();

  return {
    register: <TStart extends () => unknown, TStop extends () => unknown>(
      resident: GatewayResident<TStart, TStop>,
    ) => {
      if (names.has(resident.name)) {
        throw new Error(`Gateway resident already registered: ${resident.name}`);
      }
      names.add(resident.name);
      residents.push(resident as GatewayResident);
      return resident;
    },
    list: () => residents,
  };
}
