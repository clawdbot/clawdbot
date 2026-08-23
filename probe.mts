const { buildInboundUserContextPrefix } = await import(
  "./src/auto-reply/reply/inbound-meta.ts"
);

function build(entryCount, blobSize) {
  const context = {
    Provider: "telegram",
    OriginatingChannel: "telegram",
    Surface: "telegram",
    ChatType: "group",
    MessageSid: "5150",
    ReplyToQuoteText: "the quoted sentence the model must answer",
    ChannelStructuredContext: Array.from({ length: entryCount }, (_, i) => ({
      label: `Bulky payload ${i}`,
      source: "telegram",
      type: "directory",
      payload: { blob: "x".repeat(blobSize) },
    })),
  };
  return buildInboundUserContextPrefix(context);
}

for (const [n, size] of [[1, 200000], [10, 60000], [40, 60000], [200, 60000]]) {
  const p = build(n, size);
  console.log(
    `entries=${n} blob=${size} len=${p.length}` +
      ` hasCurrent=${p.includes("Current message:")}` +
      ` hasQuote=${p.includes("the quoted sentence the model must answer")}` +
      ` exhausted=${p.includes("context budget exhausted")}`,
  );
}
