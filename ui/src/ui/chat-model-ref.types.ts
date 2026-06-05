// Control UI type declarations define chat model ref contracts.
export type ChatModelOverride =
  | {
      kind: "qualified";
      value: string;
    }
  | {
      kind: "raw";
      value: string;
    };
