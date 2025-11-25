export type MsgContext = {
	Body?: string;
	From?: string;
	To?: string;
	MessageSid?: string;
};

export type TemplateContext = MsgContext & {
	BodyStripped?: string;
	SessionId?: string;
	IsNewSession?: string;
};

export function applyTemplate(str: string, ctx: TemplateContext) {
	// Simple {{Placeholder}} interpolation using inbound message context.
	return str.replace(/{{\s*(\w+)\s*}}/g, (_, key) => {
		const value = (ctx as Record<string, unknown>)[key];
		return value == null ? "" : String(value);
	});
}
