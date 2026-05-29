import { describe, expect, it } from "vitest";
import {
  resolveMSTeamsSdkCloudOptions,
  validateMSTeamsProactiveServiceUrlBoundary,
} from "./cloud.js";

describe("resolveMSTeamsSdkCloudOptions", () => {
  it("defaults to public cloud without an explicit serviceUrl", () => {
    expect(resolveMSTeamsSdkCloudOptions({})).toEqual({ cloud: "Public" });
  });

  it("passes serviceUrl override through with default public cloud", () => {
    expect(
      resolveMSTeamsSdkCloudOptions({
        serviceUrl: " https://smba.infra.gcc.teams.microsoft.com/teams ",
      }),
    ).toEqual({
      cloud: "Public",
      serviceUrl: "https://smba.infra.gcc.teams.microsoft.com/teams",
    });
  });

  it("requires serviceUrl when US government cloud is configured", () => {
    expect(() => resolveMSTeamsSdkCloudOptions({ cloud: "USGov" })).toThrow(
      /channels\.msteams\.cloud=USGov requires channels\.msteams\.serviceUrl/,
    );
  });

  it("allows China cloud without a configured global serviceUrl", () => {
    expect(resolveMSTeamsSdkCloudOptions({ cloud: "China" })).toEqual({
      cloud: "China",
    });
  });

  it("passes configured cloud and serviceUrl through to the SDK", () => {
    expect(
      resolveMSTeamsSdkCloudOptions({
        cloud: "USGovDoD",
        serviceUrl: " https://smba.infra.dod.teams.microsoft.us/teams ",
      }),
    ).toEqual({
      cloud: "USGovDoD",
      serviceUrl: "https://smba.infra.dod.teams.microsoft.us/teams",
    });
  });
});

describe("validateMSTeamsProactiveServiceUrlBoundary", () => {
  it("allows public-cloud stored serviceUrls with the default public cloud", () => {
    expect(() =>
      validateMSTeamsProactiveServiceUrlBoundary({
        cloud: "Public",
        conversationId: "19:conversation@thread.tacv2",
        storedServiceUrl: "https://smba.trafficmanager.net/amer/",
      }),
    ).not.toThrow();
  });

  it("blocks non-public stored serviceUrls when public cloud is configured", () => {
    expect(() =>
      validateMSTeamsProactiveServiceUrlBoundary({
        cloud: "Public",
        conversationId: "19:conversation@thread.tacv2",
        storedServiceUrl: "https://smba.infra.gcc.example/teams",
      }),
    ).toThrow(/not a Microsoft Teams public-cloud Bot Connector endpoint/);
  });

  it("allows China cloud stored serviceUrls on the Azure China Bot Framework boundary", () => {
    expect(() =>
      validateMSTeamsProactiveServiceUrlBoundary({
        cloud: "China",
        conversationId: "19:conversation@thread.tacv2",
        storedServiceUrl: "https://msteams.botframework.azure.cn/teams/",
      }),
    ).not.toThrow();
  });

  it("blocks non-China serviceUrls when China cloud is configured without a serviceUrl", () => {
    expect(() =>
      validateMSTeamsProactiveServiceUrlBoundary({
        cloud: "China",
        conversationId: "19:conversation@thread.tacv2",
        storedServiceUrl: "https://smba.trafficmanager.net/teams/",
      }),
    ).toThrow(/not a Microsoft Teams China Bot Framework channel endpoint/);
  });

  it("blocks configured non-China serviceUrls when China cloud is configured", () => {
    expect(() =>
      validateMSTeamsProactiveServiceUrlBoundary({
        cloud: "China",
        conversationId: "19:conversation@thread.tacv2",
        storedServiceUrl: "https://smba.trafficmanager.net/teams/",
        configuredServiceUrl: "https://smba.trafficmanager.net/teams",
      }),
    ).toThrow(/configured Teams serviceUrl .*not a Microsoft Teams China Bot Framework/);
  });

  it("blocks configured China serviceUrls unless China cloud is configured", () => {
    expect(() =>
      validateMSTeamsProactiveServiceUrlBoundary({
        cloud: "Public",
        conversationId: "19:conversation@thread.tacv2",
        storedServiceUrl: "https://msteams.botframework.azure.cn/teams/",
        configuredServiceUrl: "https://msteams.botframework.azure.cn/teams",
      }),
    ).toThrow(/requires channels\.msteams\.cloud=China/);
  });

  it("requires serviceUrl when non-public cloud is configured", () => {
    expect(() =>
      validateMSTeamsProactiveServiceUrlBoundary({
        cloud: "USGov",
        conversationId: "19:conversation@thread.tacv2",
        storedServiceUrl: "https://gov.example.us/teams",
      }),
    ).toThrow(/cloud=USGov requires channels\.msteams\.serviceUrl/);
  });

  it("blocks configured serviceUrl host mismatches", () => {
    expect(() =>
      validateMSTeamsProactiveServiceUrlBoundary({
        cloud: "USGovDoD",
        conversationId: "19:conversation@thread.tacv2",
        storedServiceUrl: "https://dod-a.example.mil/teams",
        configuredServiceUrl: "https://dod-b.example.mil/teams",
      }),
    ).toThrow(/does not match configured Teams SDK serviceUrl host/);
  });

  it("allows configured serviceUrl host matches with different paths", () => {
    expect(() =>
      validateMSTeamsProactiveServiceUrlBoundary({
        cloud: "USGov",
        conversationId: "19:conversation@thread.tacv2",
        storedServiceUrl: "https://connector.example.cn/teams-region/",
        configuredServiceUrl: "https://connector.example.cn/teams",
      }),
    ).not.toThrow();
  });

  it("allows configured China serviceUrl host matches with different paths", () => {
    expect(() =>
      validateMSTeamsProactiveServiceUrlBoundary({
        cloud: "China",
        conversationId: "19:conversation@thread.tacv2",
        storedServiceUrl: "https://msteams.botframework.azure.cn/teams-region/",
        configuredServiceUrl: "https://msteams.botframework.azure.cn/teams",
      }),
    ).not.toThrow();
  });
});
