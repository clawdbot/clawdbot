import { describe, expect, it, onTestFinished, vi } from "vitest";
import { mintCronCreatorAuthorityGrant } from "../gateway/cron-creator-authority-grant.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { createTestAdmittedRunContext } from "./admitted-run-context.test-support.js";
import {
  bindActiveOperatorTurnAuthority,
  bindActiveCronCreatorAuthorityResolver,
  bindCronManagementGrant,
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapabilityResolver,
} from "./cron-creator-authority-context.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
  withoutGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";

describe("bindActiveOperatorTurnAuthority", () => {
  it("binds an explicit exact-run origin and expires retained authority", async () => {
    const capability = createCronCreatorAuthorityCapability("owner-run", {
      kind: "external",
      channel: "discord",
    });
    if (!capability) {
      throw new Error("expected capability");
    }
    let retained: ReturnType<typeof bindActiveOperatorTurnAuthority>;

    await runWithCronCreatorAuthorityCapability(capability, async () => {
      expect(bindActiveOperatorTurnAuthority("other-run")).toBeUndefined();
      retained = bindActiveOperatorTurnAuthority("owner-run");
      expect(retained?.source).toBe("channel-owner");
      expect(() => retained?.assertActive()).not.toThrow();
    });

    expect(() => retained?.assertActive()).toThrow();
  });

  it("does not promote an unknown active origin", async () => {
    const capability = createCronCreatorAuthorityCapability("unknown-run");
    if (!capability) {
      throw new Error("expected capability");
    }

    await runWithCronCreatorAuthorityCapability(capability, async () => {
      expect(bindActiveOperatorTurnAuthority("unknown-run")).toBeUndefined();
    });
  });
});

describe("bindCronManagementGrant", () => {
  it.each(["local", "unknown"] as const)(
    "keeps %s admin admission within its original creator and operator authority",
    async (kind) => {
      const runId = "control-ui-scope-run";
      const { operationalRunInstance } = createTestAdmittedRunContext(runId);
      const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
      onTestFinished(() => {
        releaseAgentRunDelegatedAuthority(authority);
      });
      const capability = createCronCreatorAuthorityCapability(runId, { kind }, true)!;
      const resolveCreator = vi.fn(async () => ({
        tools: ["read"],
        provenance: { version: 1 as const, source: "final-executable-surface" as const },
      }));
      await runWithCronCreatorAuthorityCapability(capability, () =>
        withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: "agent:main:control-ui",
            operationalRunInstance,
            approvalAuthority: authority,
          },
          async () => {
            expect(
              withoutGatewayToolCallerIdentity(() => bindCronManagementGrant(runId)),
            ).toBeUndefined();
            const management = bindCronManagementGrant(runId)!;
            expect(management.managementOnly).toBe(kind === "unknown");
            const mint = management.mint;
            for (const method of [
              "cron.list",
              "cron.get",
              "cron.update",
              "cron.run",
              "cron.remove",
            ]) {
              expect(mint(method)).toMatchObject({ runId, token: expect.any(String) });
            }
            const operator = bindActiveOperatorTurnAuthority(runId);
            const creator = runWithCronCreatorAuthorityCapabilityResolver({
              capability,
              runId,
              resolve: resolveCreator,
              run: () => bindActiveCronCreatorAuthorityResolver(runId),
            });
            if (kind === "local") {
              expect(operator?.source).toBe("local");
              await expect(creator!()).resolves.toMatchObject({ tools: ["read"] });
            } else {
              expect(operator).toBeUndefined();
              expect(creator).toBeUndefined();
              expect(resolveCreator).not.toHaveBeenCalled();
              expect(() => mintCronCreatorAuthorityGrant(capability)).toThrow(
                "Automation creation is not granted",
              );
            }
            for (const method of ["cron.add", "cron.status", "cron.runs", "wake"]) {
              if (kind === "local") {
                expect(mint(method)).toBeUndefined();
              } else {
                expect(() => mint(method)).toThrow("Use the Automations page for other actions");
              }
            }
            releaseAgentRunDelegatedAuthority(authority);
            expect(bindCronManagementGrant(runId)).toBeUndefined();
          },
        ),
      );
    },
  );

  it("does not transfer an admin tool's authority to a replacement with the same run id", async () => {
    const runId = "control-ui-admin-run";
    const { operationalRunInstance } = createTestAdmittedRunContext(runId);
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    onTestFinished(() => {
      releaseAgentRunDelegatedAuthority(authority);
    });
    const capability = createCronCreatorAuthorityCapability(runId, { kind: "local" }, true);
    if (!capability) {
      throw new Error("expected admin capability");
    }
    const caller = {
      agentId: "main",
      sessionKey: "agent:main:control-ui",
      operationalRunInstance,
      approvalAuthority: authority,
    };

    await runWithCronCreatorAuthorityCapability(capability, () =>
      withGatewayToolCallerIdentity(caller, async () => {
        const mint = bindCronManagementGrant(runId)?.mint;
        expect(mint).toBeTypeOf("function");
        expect(() => mint!("cron.get")).not.toThrow();

        const replacement = createTestAdmittedRunContext(runId).operationalRunInstance;
        const replacementAuthority = claimAgentRunDelegatedAuthority(replacement);
        onTestFinished(() => {
          releaseAgentRunDelegatedAuthority(replacementAuthority);
        });
        await withGatewayToolCallerIdentity(
          {
            ...caller,
            operationalRunInstance: replacement,
            approvalAuthority: replacementAuthority,
          },
          async () => {
            expect(getGatewayToolCallerIdentity()?.approvalAuthority).toBe(replacementAuthority);
            expect(() => mint!("cron.get")).toThrow(
              "Retry from a fresh authenticated Control UI administrator turn",
            );
          },
        );
      }),
    );
  });
});
