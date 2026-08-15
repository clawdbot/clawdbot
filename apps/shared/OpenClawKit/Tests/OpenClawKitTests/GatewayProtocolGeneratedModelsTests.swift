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
}
