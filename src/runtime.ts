export type RuntimeEnv = {
	log: typeof console.log;
	error: typeof console.error;
	exit: (code: number) => never;
};

export const defaultRuntime: RuntimeEnv = {
	log: console.log,
	error: console.error,
	exit: (code) => {
		process.exit(code);
		throw new Error("unreachable"); // satisfies tests when mocked
	},
};
