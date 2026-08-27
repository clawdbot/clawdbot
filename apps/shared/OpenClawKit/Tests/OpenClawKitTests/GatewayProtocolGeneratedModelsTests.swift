import Foundation
import OpenClawProtocol
import Testing

struct GatewayProtocolGeneratedModelsTests {
    @Test(arguments: [
        (#"{"type":"profile","id":"same"}"#, "profile"),
        (#"{"type":"agent","id":"same"}"#, "agent"),
        (#"{"type":"remote","pluginId":"slack","domain":"workspace","idKind":"user","id":"same"}"#, "remote"),
        (#"{"type":"observation","pluginId":null,"accountId":null,"senderKind":"unknown","id":"same"}"#, "observation"),
        (#"{"type":"legacy","actorType":"human","source":null,"id":"same"}"#, "legacy"),
    ])
    func `inline object union branches have typed declarations and round trip`(
        json: String,
        expectedType: String) throws
    {
        let data = Data(#"{"identity":\#(json)}"#.utf8)
        let participant = try JSONDecoder().decode(SessionParticipant.self, from: data)
        switch participant.identity {
        case .profile: #expect(expectedType == "profile")
        case .agent: #expect(expectedType == "agent")
        case .remote: #expect(expectedType == "remote")
        case .observation: #expect(expectedType == "observation")
        case .legacy: #expect(expectedType == "legacy")
        }
        let encoded = try JSONEncoder().encode(participant)
        let actual = try #require(JSONSerialization.jsonObject(with: encoded) as? NSDictionary)
        let expected = try #require(JSONSerialization.jsonObject(with: data) as? NSDictionary)
        #expect(actual == expected)
    }

    @Test(arguments: [
        #"{"type":"unknown","id":"same"}"#,
        #"{"type":"profile"}"#,
        #"{"type":"profile","id":"same","pluginId":"slack"}"#,
        #"{"type":"remote","id":"same"}"#,
    ])
    func `inline object union decoding rejects unknown incomplete and mixed variants`(json: String) {
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(SessionParticipantIdentity.self, from: Data(json.utf8))
        }
    }

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
        #expect(params.abandonsource == nil)
        guard case let .profile(profile) = params.target else {
            Issue.record("Expected the generated profile move target")
            return
        }
        #expect(profile.profileid == "development")

        let abandonment = try JSONDecoder().decode(
            SessionsMoveParams.self,
            from: Data(
                #"{"key":"agent:main:move","expected":{"generation":4,"environmentId":"environment-1","ownerEpoch":7},"target":{"kind":"gateway"},"abandonSource":true}"#
                    .utf8))
        #expect(abandonment.abandonsource == true)
        guard case .gateway = abandonment.target else {
            Issue.record("Expected the generated abandonment move to target the Gateway")
            return
        }

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
            #expect(payload.scope.rawValue == expectedScope)
            #expect(payload.agentid == "main")
            #expect(payload.secretname.hasPrefix("github-setup-"))
        case let .inherit(payload):
            #expect(!expectedManaged)
            #expect(payload.scope.rawValue == expectedScope)
            #expect(payload.agentid == "main")
        }

        let encoded = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(params)) as? [String: Any])
        #expect(encoded["scope"] as? String == expectedScope)
        #expect(encoded["mode"] as? String == (expectedManaged ? "managed" : "inherit"))
    }

    @Test(arguments: [
        (#"{"requestId":"request-1","status":"requested","message":"Accepted."}"#, "requested"),
        (#"{"requestId":"request-1","status":"publishing","message":"Publishing."}"#, "publishing"),
        (
            #"{"requestId":"request-1","status":"published","url":"https://github.com/openclaw/openclaw/pull/1","repository":"openclaw/openclaw","branch":"openclaw/task","headCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#,
            "published"),
        (
            #"{"requestId":"request-1","status":"failed","code":"push_rejected","message":"Failed.","nextAction":"Check access."}"#,
            "failed"),
    ])
    func `GitHub publication results round trip as a typed union`(
        json: String,
        expectedStatus: String) throws
    {
        let result = try JSONDecoder().decode(
            SessionGitHubPublicationResult.self,
            from: Data(json.utf8))
        switch result {
        case .requested: #expect(expectedStatus == "requested")
        case .publishing: #expect(expectedStatus == "publishing")
        case .published: #expect(expectedStatus == "published")
        case .failed: #expect(expectedStatus == "failed")
        }

        let encoded = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(result)) as? [String: Any])
        #expect(encoded["status"] as? String == expectedStatus)
    }

    @Test(arguments: [
        (#"{"status":"pending","retryAfterMs":5000}"#, "pending"),
        (#"{"status":"slow_down","retryAfterMs":10000}"#, "slow_down"),
        (#"{"status":"access_denied"}"#, "access_denied"),
        (#"{"status":"expired"}"#, "expired"),
        (#"{"status":"incorrect_device_code"}"#, "incorrect_device_code"),
        (#"{"status":"network_error","retryAfterMs":5000}"#, "network_error"),
        (#"{"status":"failed","reason":"identity_changed"}"#, "failed"),
        (
            #"{"status":"success","githubStatus":{"agentId":"main","selectedScope":"system","selected":{"scope":"system","configured":true,"identity":{"source":"system-configured","credentialKind":"managed-oauth","credentialState":"available","account":{"login":"octocat"},"gitAuthor":{"name":"octocat","email":"1+octocat@users.noreply.github.com"},"evidence":"github-api","accessExpiresAtMs":1800000000000,"refreshState":"available","oauthScopes":["repo"],"repositoryGrants":"unknown"}},"effective":{"source":"system-configured","credentialKind":"managed-oauth","credentialState":"available","account":{"login":"octocat"},"gitAuthor":{"name":"octocat","email":"1+octocat@users.noreply.github.com"},"evidence":"github-api","accessExpiresAtMs":1800000000000,"refreshState":"available","oauthScopes":["repo"],"repositoryGrants":"unknown"}}}"#,
            "success"),
    ])
    func `GitHub device authorization results round trip every outcome`(
        json: String,
        expectedStatus: String) throws
    {
        let result = try JSONDecoder().decode(
            ToolsGitHubAuthorizePollResult.self,
            from: Data(json.utf8))
        switch result {
        case .pending: #expect(expectedStatus == "pending")
        case .slowDown: #expect(expectedStatus == "slow_down")
        case .accessDenied: #expect(expectedStatus == "access_denied")
        case .expired: #expect(expectedStatus == "expired")
        case .incorrectDeviceCode: #expect(expectedStatus == "incorrect_device_code")
        case .networkError: #expect(expectedStatus == "network_error")
        case .failed: #expect(expectedStatus == "failed")
        case .success: #expect(expectedStatus == "success")
        }

        let encoded = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(result)) as? [String: Any])
        #expect(encoded["status"] as? String == expectedStatus)
    }
}
