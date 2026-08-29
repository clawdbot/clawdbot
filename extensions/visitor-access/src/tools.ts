import { Type } from "typebox";
import type { AnyAgentTool, OpenClawPluginToolContext } from "../api.js";
import { visitorRuntimeStore } from "./runtime.js";
import type { VisitorAccessService } from "./visitors.js";

const identityFields = {
  github: Type.Optional(
    Type.String({ description: "GitHub login, without @.", minLength: 1, maxLength: 39 }),
  ),
  email: Type.Optional(
    Type.String({
      description: "Verified email on the visitor's GitHub account.",
      minLength: 1,
      maxLength: 254,
    }),
  ),
};

export function createVisitorTools(context: OpenClawPluginToolContext): AnyAgentTool[] {
  let runtime = visitorRuntimeStore.tryGetRuntime();
  const definitions = [
    {
      name: "visitor_invite",
      label: "Invite visitor",
      description:
        "Grant or renew visitor access to team.openclaw.ai. Provide email or GitHub login; private GitHub emails require explicit email. Grants expire after the configured duration (14 days by default); forever must be explicit.",
      parameters: Type.Object(
        {
          ...identityFields,
          days: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 3650,
              description: "Grant duration in days; cannot be combined with forever.",
            }),
          ),
          forever: Type.Optional(
            Type.Boolean({ description: "Explicitly grant access without expiry." }),
          ),
        },
        { additionalProperties: false },
      ),
      run: (service: VisitorAccessService, raw: unknown) =>
        service.invite(raw, context.sessionKey ?? context.agentId),
    },
    {
      name: "visitor_revoke",
      label: "Revoke visitor",
      description:
        "Remove visitor access by email or GitHub login. GitHub login removes all recorded grants for that login. Explicit email can also remove an unmanaged policy entry. Already absent grants are a no-op.",
      parameters: Type.Object(identityFields, { additionalProperties: false }),
      run: (service: VisitorAccessService, raw: unknown) => service.revoke(raw),
    },
    {
      name: "visitor_list",
      label: "List visitors",
      description:
        "List recorded visitor grants, invitation and expiry dates, and drift from the Access policy. Unmanaged policy emails are reported and retained; missing policy emails are never automatically restored.",
      parameters: Type.Object({}, { additionalProperties: false }),
      run: (service: VisitorAccessService) => service.list(),
    },
  ];
  return definitions.map(({ name, label, description, parameters, run }) => ({
    name,
    label,
    description,
    parameters,
    async execute(_id, raw) {
      // Bind once; a retained tool cannot inherit a replacement service's lifetime.
      runtime ??= visitorRuntimeStore.tryGetRuntime();
      if (!runtime) {
        return {
          content: [
            {
              type: "text",
              text: "Start the Gateway with visitor-access enabled before managing visitors.",
            },
          ],
          details: { error: true },
          isError: true,
        };
      }
      try {
        return { content: [{ type: "text", text: await run(runtime.service, raw) }], details: {} };
      } catch (error) {
        return {
          content: [{ type: "text", text: runtime.errorText(error) }],
          details: { error: true },
          isError: true,
        };
      }
    },
  }));
}
