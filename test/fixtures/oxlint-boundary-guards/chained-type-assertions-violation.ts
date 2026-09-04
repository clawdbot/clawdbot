declare const input: unknown;

input as unknown as { readonly id: string };
input as object as Record<string, unknown> as { readonly id: string };
<{ readonly id: string }>(input as object);

input as { readonly id: string };
({ id: "fixture" }) as const as const;
