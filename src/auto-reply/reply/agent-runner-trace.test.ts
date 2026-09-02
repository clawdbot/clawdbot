import { describe, expect, it } from "vitest";
import { derivePromptSegments } from "./agent-runner-trace.js";
import { markInboundContextLabel } from "./inbound-context-marker.js";

describe("derivePromptSegments", () => {
  const context = "Context:\n<attachment>\nimg\n</attachment>";
  const metadata = `${markInboundContextLabel("Conversation info:")}\n\`\`\`json\n{}\n\`\`\``;

  it.each([
    { name: "Context block at EOF", block: context, trailing: "", key: "attachment" },
    {
      name: "Context block with trailing empty lines",
      block: context,
      trailing: "\n\n",
      key: "attachment",
    },
    { name: "metadata fence at EOF", block: metadata, trailing: "", key: "conversation_metadata" },
    {
      name: "metadata fence with trailing empty lines",
      block: metadata,
      trailing: "\n\n",
      key: "conversation_metadata",
    },
  ])("attributes $name without user content", ({ block, trailing, key }) => {
    expect(derivePromptSegments(block + trailing)).toEqual([{ key, chars: block.length }]);
  });

  it("keeps user content after consecutive context and metadata blocks", () => {
    expect(derivePromptSegments(`${context}\n\n${metadata}\n\nHello`)).toEqual([
      { key: "attachment", chars: context.length },
      { key: "conversation_metadata", chars: metadata.length },
      { key: "user_message", chars: 6 },
    ]);
  });
});
