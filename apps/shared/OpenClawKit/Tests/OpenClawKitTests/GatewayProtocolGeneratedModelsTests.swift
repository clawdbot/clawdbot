import Foundation
import OpenClawProtocol
import Testing

struct GatewayProtocolGeneratedModelsTests {
    @Test
    func `generated frames decode legacy minimums and additive fields`() throws {
        let request = try JSONDecoder().decode(
            GatewayFrame.self,
            from: Data(#"{"type":"req","id":"old-req","method":"health"}"#.utf8))
        let additiveRequest = try JSONDecoder().decode(
            GatewayFrame.self,
            from: Data(
                #"{"type":"req","id":"new-req","method":"health","traceparent":"00-0123456789abcdef0123456789abcdef-0123456789abcdef-01","futureField":true}"#
                    .utf8))
        let response = try JSONDecoder().decode(
            GatewayFrame.self,
            from: Data(#"{"type":"res","id":"old-req","ok":true}"#.utf8))
        let additiveResponse = try JSONDecoder().decode(
            GatewayFrame.self,
            from: Data(
                #"{"type":"res","id":"new-req","ok":true,"payload":{"healthy":true},"futureField":true}"#.utf8))
        let event = try JSONDecoder().decode(
            GatewayFrame.self,
            from: Data(#"{"type":"event","event":"tick"}"#.utf8))
        let additiveEvent = try JSONDecoder().decode(
            GatewayFrame.self,
            from: Data(
                #"{"type":"event","event":"tick","payload":{"ts":1},"seq":2,"futureField":true}"#.utf8))

        guard case let .req(oldRequest) = request,
              case let .req(newRequest) = additiveRequest,
              case let .res(oldResponse) = response,
              case let .res(newResponse) = additiveResponse,
              case let .event(oldEvent) = event,
              case let .event(newEvent) = additiveEvent
        else {
            Issue.record("Expected generated request, response, and event frame cases")
            return
        }

        #expect(oldRequest.params == nil)
        #expect(oldRequest.traceparent == nil)
        #expect(newRequest.traceparent == "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01")
        #expect(oldResponse.payload == nil)
        #expect(newResponse.payload != nil)
        #expect(oldEvent.seq == nil)
        #expect(newEvent.seq == 2)
    }

    @Test
    func `generated connect model decodes old and additive handshakes`() throws {
        let legacy = try JSONDecoder().decode(
            ConnectParams.self,
            from: Data(
                #"{"minProtocol":4,"maxProtocol":4,"client":{"id":"test","version":"old","platform":"ios","mode":"test"}}"#
                    .utf8))
        let additive = try JSONDecoder().decode(
            ConnectParams.self,
            from: Data(
                #"{"minProtocol":4,"maxProtocol":4,"client":{"id":"test","version":"new","platform":"ios","mode":"test","futureClientField":true},"role":"operator","scopes":["operator.read"],"locale":"en-US","futureField":true}"#
                    .utf8))

        #expect(legacy.role == nil)
        #expect(legacy.scopes == nil)
        #expect(legacy.locale == nil)
        #expect(additive.role == "operator")
        #expect(additive.scopes == ["operator.read"])
        #expect(additive.locale == "en-US")
    }

    @Test
    func `projects list result decodes a legacy projects-only payload`() throws {
        let result = try JSONDecoder().decode(
            ProjectsListResult.self,
            from: Data(#"{"projects":[]}"#.utf8))

        #expect(result.projects.isEmpty)
        #expect(result.observedprojects == nil)
    }

    @Test
    func `session move models preserve exact source and closed targets`() throws {
        let params = try JSONDecoder().decode(
            SessionsMoveParams.self,
            from: Data(
                #"{"key":"agent:main:move","expected":{"generation":4,"environmentId":"environment-1","ownerEpoch":7},"target":{"kind":"profile","profileId":"development"}}"#
                    .utf8))

        #expect(params.expected.generation == 4)
        #expect(params.expected.environmentid == "environment-1")
        #expect(params.expected.ownerepoch == 7)
        guard case let .profile(profile) = params.target else {
            Issue.record("Expected the generated profile move target")
            return
        }
        #expect(profile.profileid == "development")

        let gateway = try JSONDecoder().decode(
            SessionMoveTarget.self,
            from: Data(#"{"kind":"gateway"}"#.utf8))
        let device = try JSONDecoder().decode(
            SessionMoveTarget.self,
            from: Data(#"{"kind":"device","deviceId":"device-1"}"#.utf8))
        guard case .gateway = gateway, case let .device(deviceTarget) = device else {
            Issue.record("Expected generated gateway and device move targets")
            return
        }
        #expect(deviceTarget.deviceid == "device-1")

        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(
                SessionMoveTarget.self,
                from: Data(#"{"kind":"other"}"#.utf8))
        }
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(
                SessionMoveTarget.self,
                from: Data(#"{"kind":"gateway","profileId":"development"}"#.utf8))
        }
    }

    @Test(arguments: [
        (
            #"{"scope":"system","agentId":"main","mode":"managed","secretName":"github-setup-11111111111111111111111111111111"}"#,
            "system",
            true),
        (
            #"{"scope":"agent","agentId":"main","mode":"managed","secretName":"github-setup-22222222222222222222222222222222","gitAuthor":{"name":"Agent"}}"#,
            "agent",
            true),
        (#"{"scope":"system","agentId":"main","mode":"inherit"}"#, "system", false),
        (#"{"scope":"agent","agentId":"main","mode":"inherit"}"#, "agent", false),
    ])
    func `GitHub configure requests round trip every scope and mode`(
        json: String,
        expectedScope: String,
        expectedManaged: Bool) throws
    {
        let params = try JSONDecoder().decode(
            ToolsGitHubConfigureParams.self,
            from: Data(json.utf8))

        switch params {
        case let .managed(payload):
            #expect(expectedManaged)
            #expect(payload.scope.value as? String == expectedScope)
            #expect(payload.agentid == "main")
            #expect(payload.secretname.hasPrefix("github-setup-"))
        case let .inherit(payload):
            #expect(!expectedManaged)
            #expect(payload.scope.value as? String == expectedScope)
            #expect(payload.agentid == "main")
        }

        let encoded = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(params)) as? [String: Any])
        #expect(encoded["scope"] as? String == expectedScope)
        #expect(encoded["mode"] as? String == (expectedManaged ? "managed" : "inherit"))
    }
}
