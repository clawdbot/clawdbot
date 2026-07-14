import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  agentsPolicyShapeFinding,
  execApprovalsPolicyShapeFinding,
  ingressPolicyShapeFinding,
} from "./access-shapes.js";
import { toolPosturePolicyShapeFinding } from "./agent-tool-shapes.js";
import { SUPPORTED_POLICY_SECTIONS } from "./policy-constants.js";
import { gatewayPolicyShapeFinding, sandboxPolicyShapeFinding } from "./sandbox-gateway-shapes.js";
import { scopedPolicyShapeFinding } from "./scoped-policy-shape.js";
import {
  policyShapeFinding,
  policyStringArrayShapeFinding,
  unsupportedPolicyKey,
} from "./shape-helpers.js";
import { ocPathSegment } from "./utils.js";

export function policyContainerShapeFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
): readonly HealthFinding[] {
  if (!isRecord(policy)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}`,
        `${policyPath} must contain a policy object.`,
        `Fix ${policyPath} so the top-level policy is an object.`,
      ),
    ];
  }
  const unsupportedTopLevel = unsupportedPolicyKey(policy, SUPPORTED_POLICY_SECTIONS);
  if (unsupportedTopLevel !== undefined) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/${ocPathSegment(unsupportedTopLevel)}`,
        `${policyPath} ${unsupportedTopLevel} is not a supported policy section.`,
        `Remove ${unsupportedTopLevel} or use a supported policy section.`,
      ),
    ];
  }
  if (policy.tools !== undefined && !isRecord(policy.tools)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/tools`,
        `${policyPath} tools must be an object.`,
        `Fix ${policyPath} so tools is an object.`,
      ),
    ];
  }
  if (isRecord(policy.tools)) {
    const postureFinding = toolPosturePolicyShapeFinding(policy.tools, {
      policyDocName,
      policyPath,
    });
    if (postureFinding !== undefined) {
      return [postureFinding];
    }
  }
  if (policy.channels !== undefined && !isRecord(policy.channels)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/channels`,
        `${policyPath} channels must be an object.`,
        `Fix ${policyPath} so channels is an object.`,
      ),
    ];
  }
  if (isRecord(policy.channels)) {
    const unsupportedChannelKey = unsupportedPolicyKey(policy.channels, ["denyRules"]);
    if (unsupportedChannelKey !== undefined) {
      return [
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/channels/${ocPathSegment(unsupportedChannelKey)}`,
          `${policyPath} channels.${unsupportedChannelKey} is not supported in channel policy.`,
          `Remove channels.${unsupportedChannelKey} or use channels.denyRules.`,
        ),
      ];
    }
  }
  if (policy.mcp !== undefined && !isRecord(policy.mcp)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/mcp`,
        `${policyPath} mcp must be an object.`,
        `Fix ${policyPath} so mcp is an object.`,
      ),
    ];
  }
  if (isRecord(policy.mcp)) {
    const unsupportedMcpKey = unsupportedPolicyKey(policy.mcp, ["servers"]);
    if (unsupportedMcpKey !== undefined) {
      return [
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/mcp/${ocPathSegment(unsupportedMcpKey)}`,
          `${policyPath} mcp.${unsupportedMcpKey} is not supported in MCP policy.`,
          `Remove mcp.${unsupportedMcpKey} or use mcp.servers.`,
        ),
      ];
    }
  }
  if (policy.dataHandling !== undefined && !isRecord(policy.dataHandling)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/dataHandling`,
        `${policyPath} dataHandling must be an object.`,
        `Fix ${policyPath} so dataHandling is an object.`,
      ),
    ];
  }
  if (isRecord(policy.mcp)) {
    const finding = policyStringArrayShapeFinding(policy.mcp.servers, {
      property: "mcp.servers",
      policyDocName,
      policyPath,
      target: "mcp/servers",
      valueName: "MCP server id",
    });
    if (finding !== undefined) {
      return [finding];
    }
  }
  if (policy.models !== undefined && !isRecord(policy.models)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/models`,
        `${policyPath} models must be an object.`,
        `Fix ${policyPath} so models is an object.`,
      ),
    ];
  }
  if (isRecord(policy.models)) {
    const unsupportedModelsKey = unsupportedPolicyKey(policy.models, ["providers"]);
    if (unsupportedModelsKey !== undefined) {
      return [
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/models/${ocPathSegment(unsupportedModelsKey)}`,
          `${policyPath} models.${unsupportedModelsKey} is not supported in model policy.`,
          `Remove models.${unsupportedModelsKey} or use models.providers.`,
        ),
      ];
    }
  }
  if (isRecord(policy.models)) {
    const finding = policyStringArrayShapeFinding(policy.models.providers, {
      property: "models.providers",
      policyDocName,
      policyPath,
      target: "models/providers",
      valueName: "model provider id",
    });
    if (finding !== undefined) {
      return [finding];
    }
  }
  if (policy.network !== undefined && !isRecord(policy.network)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/network`,
        `${policyPath} network must be an object.`,
        `Fix ${policyPath} so network is an object.`,
      ),
    ];
  }
  if (isRecord(policy.network)) {
    const unsupportedNetworkKey = unsupportedPolicyKey(policy.network, ["privateNetwork"]);
    if (unsupportedNetworkKey !== undefined) {
      return [
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/network/${ocPathSegment(unsupportedNetworkKey)}`,
          `${policyPath} network.${unsupportedNetworkKey} is not supported in network policy.`,
          `Remove network.${unsupportedNetworkKey} or use network.privateNetwork.`,
        ),
      ];
    }
    if (policy.network.privateNetwork !== undefined && !isRecord(policy.network.privateNetwork)) {
      return [
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/network/privateNetwork`,
          `${policyPath} network.privateNetwork must be an object.`,
          `Fix ${policyPath} so network.privateNetwork is an object.`,
        ),
      ];
    }
    if (isRecord(policy.network.privateNetwork)) {
      const unsupportedPrivateNetworkKey = unsupportedPolicyKey(policy.network.privateNetwork, [
        "allow",
      ]);
      if (unsupportedPrivateNetworkKey !== undefined) {
        return [
          policyShapeFinding(
            policyPath,
            `oc://${policyDocName}/network/privateNetwork/${ocPathSegment(unsupportedPrivateNetworkKey)}`,
            `${policyPath} network.privateNetwork.${unsupportedPrivateNetworkKey} is not supported in network policy.`,
            `Remove network.privateNetwork.${unsupportedPrivateNetworkKey} or use network.privateNetwork.allow.`,
          ),
        ];
      }
    }
    if (
      isRecord(policy.network.privateNetwork) &&
      policy.network.privateNetwork.allow !== undefined &&
      typeof policy.network.privateNetwork.allow !== "boolean"
    ) {
      return [
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/network/privateNetwork/allow`,
          `${policyPath} network.privateNetwork.allow must be a boolean.`,
          `Fix ${policyPath} so network.privateNetwork.allow is true or false.`,
        ),
      ];
    }
  }
  if (policy.secrets !== undefined && !isRecord(policy.secrets)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/secrets`,
        `${policyPath} secrets must be an object.`,
        `Fix ${policyPath} so secrets is an object.`,
      ),
    ];
  }
  if (isRecord(policy.secrets)) {
    const unsupportedSecretsKey = unsupportedPolicyKey(policy.secrets, [
      "allowInsecureProviders",
      "denySources",
      "requireManagedProviders",
    ]);
    if (unsupportedSecretsKey !== undefined) {
      return [
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/secrets/${ocPathSegment(unsupportedSecretsKey)}`,
          `${policyPath} secrets.${unsupportedSecretsKey} is not supported in secrets policy.`,
          `Remove secrets.${unsupportedSecretsKey} or use a supported secrets policy rule.`,
        ),
      ];
    }
  }
  if (policy.auth !== undefined && !isRecord(policy.auth)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/auth`,
        `${policyPath} auth must be an object.`,
        `Fix ${policyPath} so auth is an object.`,
      ),
    ];
  }
  if (isRecord(policy.auth)) {
    const unsupportedAuthKey = unsupportedPolicyKey(policy.auth, ["profiles"]);
    if (unsupportedAuthKey !== undefined) {
      return [
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/auth/${ocPathSegment(unsupportedAuthKey)}`,
          `${policyPath} auth.${unsupportedAuthKey} is not supported in auth policy.`,
          `Remove auth.${unsupportedAuthKey} or use auth.profiles.`,
        ),
      ];
    }
  }
  if (
    isRecord(policy.auth) &&
    policy.auth.profiles !== undefined &&
    !isRecord(policy.auth.profiles)
  ) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/auth/profiles`,
        `${policyPath} auth.profiles must be an object.`,
        `Fix ${policyPath} so auth.profiles is an object.`,
      ),
    ];
  }
  if (isRecord(policy.auth) && isRecord(policy.auth.profiles)) {
    const unsupportedProfilesKey = unsupportedPolicyKey(policy.auth.profiles, [
      "allowModes",
      "requireMetadata",
    ]);
    if (unsupportedProfilesKey !== undefined) {
      return [
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/auth/profiles/${ocPathSegment(unsupportedProfilesKey)}`,
          `${policyPath} auth.profiles.${unsupportedProfilesKey} is not supported in auth profile policy.`,
          `Remove auth.profiles.${unsupportedProfilesKey} or use a supported auth profile policy rule.`,
        ),
      ];
    }
  }

  const execApprovalsFinding = execApprovalsPolicyShapeFinding(policy.execApprovals, {
    policyDocName,
    policyPath,
  });
  if (execApprovalsFinding !== undefined) {
    return [execApprovalsFinding];
  }
  const sandboxFinding = sandboxPolicyShapeFinding(policy.sandbox, {
    policyDocName,
    policyPath,
  });
  if (sandboxFinding !== undefined) {
    return [sandboxFinding];
  }
  const ingressFindingValue = ingressPolicyShapeFinding(policy.ingress, {
    policyDocName,
    policyPath,
  });
  if (ingressFindingValue !== undefined) {
    return [ingressFindingValue];
  }
  const gatewayFinding = gatewayPolicyShapeFinding(policy.gateway, {
    policyDocName,
    policyPath,
  });
  if (gatewayFinding !== undefined) {
    return [gatewayFinding];
  }
  const agentsFinding = agentsPolicyShapeFinding(policy.agents, {
    policyDocName,
    policyPath,
  });
  if (agentsFinding !== undefined) {
    return [agentsFinding];
  }
  const scopesFinding = scopedPolicyShapeFinding(policy.scopes, {
    policyDocName,
    policyPath,
    policy,
  });
  if (scopesFinding !== undefined) {
    return [scopesFinding];
  }
  return [];
}
