import Testing
@testable import Moltbot

@Suite struct SettingsNetworkingHelpersTests {
    @Test func parseHostPortParsesIPv4() {
        #expect(SettingsNetworkingHelpers.parseHostPort(from: "127.0.0.1:8080") == .init(host: "127.0.0.1", port: 8080))
    }

    @Test func parseHostPortParsesHostnameAndTrims() {
        #expect(SettingsNetworkingHelpers.parseHostPort(from: "  example.com:80 \n") == .init(
            host: "example.com",
            port: 80))
    }

    @Test func parseHostPortParsesBracketedIPv6() {
        #expect(
            SettingsNetworkingHelpers.parseHostPort(from: "[2001:db8::1]:443") ==
                .init(host: "2001:db8::1", port: 443))
    }

    @Test func parseHostPortRejectsMissingPort() {
        #expect(SettingsNetworkingHelpers.parseHostPort(from: "example.com") == nil)
        #expect(SettingsNetworkingHelpers.parseHostPort(from: "[2001:db8::1]") == nil)
    }

    @Test func parseHostPortRejectsInvalidPort() {
        #expect(SettingsNetworkingHelpers.parseHostPort(from: "example.com:lol") == nil)
        #expect(SettingsNetworkingHelpers.parseHostPort(from: "[2001:db8::1]:lol") == nil)
    }

    @Test func httpURLStringFormatsIPv4AndPort() {
        #expect(SettingsNetworkingHelpers
            .httpURLString(host: "127.0.0.1", port: 8080, fallback: "fallback") == "http://127.0.0.1:8080")
    }

    @Test func httpURLStringBracketsIPv6() {
        #expect(SettingsNetworkingHelpers
            .httpURLString(host: "2001:db8::1", port: 8080, fallback: "fallback") == "http://[2001:db8::1]:8080")
    }

    @Test func httpURLStringLeavesAlreadyBracketedIPv6() {
        #expect(SettingsNetworkingHelpers
            .httpURLString(host: "[2001:db8::1]", port: 8080, fallback: "fallback") == "http://[2001:db8::1]:8080")
    }

    @Test func httpURLStringFallsBackWhenMissingHostOrPort() {
        #expect(SettingsNetworkingHelpers.httpURLString(host: nil, port: 80, fallback: "x") == "http://x")
        #expect(SettingsNetworkingHelpers.httpURLString(host: "example.com", port: nil, fallback: "y") == "http://y")
    }
}
