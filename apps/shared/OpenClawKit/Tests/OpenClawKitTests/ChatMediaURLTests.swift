import Foundation
import Testing
@testable import OpenClawChatUI

struct ChatMediaURLTests {
    @Test(arguments: [
        ("ws://gateway.example:18789", "http://gateway.example:18789"),
        ("http://gateway.example/", "http://gateway.example"),
        ("wss://gateway.example/tenant%20gateway/gw", "https://gateway.example/tenant%20gateway/gw"),
        ("https://gateway.example/tenant%2Fgateway//gw/", "https://gateway.example/tenant%2Fgateway//gw/"),
        ("wss://gateway.example/tenant%FFgateway/gw", "https://gateway.example/tenant%FFgateway/gw"),
    ])
    func `preserves gateway route and ticket`(route: (gateway: String, media: String)) throws {
        let gateway = try #require(URL(string: route.gateway))
        let ticketedPath = Self.mediaPath + "?mediaTicket=synthetic%2Fticket%3D&download=1"
        let url = OpenClawChatMediaURL.resolve(gatewayURL: gateway, ticketedPath: ticketedPath, playback: nil)
        #expect(url?.absoluteString == route.media + ticketedPath)
    }

    @Test func `rendition replaces playback without gateway query`() throws {
        let gateway = try #require(URL(string: "wss://gateway.example/proxy?ignored=1#ignored"))
        let ticketedPath = Self.mediaPath + "?mediaTicket=synthetic%2Fticket%3D&playback=0&playback=2"
        let url = try #require(OpenClawChatMediaURL.resolve(
            gatewayURL: gateway,
            ticketedPath: ticketedPath,
            playback: .transcode))
        #expect(url.scheme == "https")
        #expect(url.path == "/proxy" + Self.mediaPath)
        let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        #expect(components.queryItems == [
            URLQueryItem(name: "mediaTicket", value: "synthetic/ticket="),
            URLQueryItem(name: "playback", value: "1"),
        ])
        #expect(components.fragment == nil)
    }

    @Test(arguments: [
        "https://other.example/api/chat/media/outgoing/main/id/full?mediaTicket=ticket",
        "//other.example/api/chat/media/outgoing/main/id/full?mediaTicket=ticket",
        "/api/chat/media/outgoing/main/id/full?mediaTicket=ticket#fragment",
        "/api/chat/media/outgoing/main/id/full",
        "/api/chat/media/outgoing/main/id/full?mediaTicket=",
        "/unrelated?mediaTicket=ticket",
    ])
    func `rejects non ticket routes`(ticketedPath: String) throws {
        let gateway = try #require(URL(string: "wss://gateway.example/proxy"))
        #expect(OpenClawChatMediaURL.resolve(
            gatewayURL: gateway,
            ticketedPath: ticketedPath,
            playback: nil) == nil)
    }

    @Test(arguments: ["ftp://gateway.example/proxy", "file:///proxy", "/proxy"])
    func `rejects non gateway UR ls`(gateway: String) throws {
        let gatewayURL = try #require(URL(string: gateway))
        #expect(OpenClawChatMediaURL.resolve(
            gatewayURL: gatewayURL,
            ticketedPath: Self.mediaPath + "?mediaTicket=ticket",
            playback: .transcode) == nil)
    }

    private static let mediaPath = "/api/chat/media/outgoing/main/11111111-1111-4111-8111-111111111111/full"
}
