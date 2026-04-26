import Foundation
import Testing
@testable import OpenClaw

struct MacNodeBrowserProxyTests {
    @Test func `request uses browser control endpoint and wraps result`() async throws {
        let proxy = MacNodeBrowserProxy(
            endpointProvider: {
                MacNodeBrowserProxy.Endpoint(
                    baseURL: URL(string: "http://127.0.0.1:18791")!,
                    token: "test-token",
                    password: nil)
            },
            performRequest: { request in
                #expect(request.url?.absoluteString == "http://127.0.0.1:18791/tabs?profile=work")
                #expect(request.httpMethod == "GET")
                #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-token")

                let body = Data(#"{"tabs":[{"id":"tab-1"}]}"#.utf8)
                let url = try #require(request.url)
                let response = try #require(
                    HTTPURLResponse(
                        url: url,
                        statusCode: 200,
                        httpVersion: nil,
                        headerFields: ["Content-Type": "application/json"]))
                return (body, response)
            })

        let payloadJSON = try await proxy.request(
            paramsJSON: #"{"method":"GET","path":"/tabs","profile":"work"}"#)
        let payload = try #require(
            JSONSerialization.jsonObject(with: Data(payloadJSON.utf8)) as? [String: Any])
        let result = try #require(payload["result"] as? [String: Any])
        let tabs = try #require(result["tabs"] as? [[String: Any]])

        #expect(payload["files"] == nil)
        #expect(tabs.count == 1)
        #expect(tabs[0]["id"] as? String == "tab-1")
    }

    // Regression test: nested POST bodies must serialize without __SwiftValue crashes.
    @Test func postRequestSerializesNestedBodyWithoutCrash() async throws {
        actor BodyCapture {
            private var body: Data?

            func set(_ body: Data?) {
                self.body = body
            }

            func get() -> Data? {
                self.body
            }
        }

        let capturedBody = BodyCapture()
        let proxy = MacNodeBrowserProxy(
            endpointProvider: {
                MacNodeBrowserProxy.Endpoint(
                    baseURL: URL(string: "http://127.0.0.1:18791")!,
                    token: nil,
                    password: nil)
            },
            performRequest: { request in
                await capturedBody.set(request.httpBody)
                let url = try #require(request.url)
                let response = try #require(
                    HTTPURLResponse(
                        url: url,
                        statusCode: 200,
                        httpVersion: nil,
                        headerFields: nil))
                return (Data(#"{"ok":true}"#.utf8), response)
            })

        _ = try await proxy.request(
            paramsJSON: #"{"method":"POST","path":"/action","body":{"nested":{"key":"val"},"arr":[1,2]}}"#)

        let bodyData = try #require(await capturedBody.get())
        let parsed = try #require(JSONSerialization.jsonObject(with: bodyData) as? [String: Any])
        let nested = try #require(parsed["nested"] as? [String: Any])
        #expect(nested["key"] as? String == "val")
        let arr = try #require(parsed["arr"] as? [Any])
        #expect(arr.count == 2)
    }

    @Test func requestReportsActionableUnavailableWhenControlServiceIsMissing() async throws {
        let proxy = MacNodeBrowserProxy(
            endpointProvider: {
                MacNodeBrowserProxy.Endpoint(
                    baseURL: URL(string: "http://127.0.0.1:18791")!,
                    token: nil,
                    password: nil)
            },
            performRequest: { _ in
                throw URLError(.cannotConnectToHost)
            })

        do {
            _ = try await proxy.request(paramsJSON: #"{"method":"GET","path":"/"}"#)
            Issue.record("request should fail when browser control is unreachable")
        } catch {
            let message = error.localizedDescription
            #expect(message.contains("UNAVAILABLE: macOS app node could not reach the local browser control service"))
            #expect(message.contains("http://127.0.0.1:18791"))
            #expect(message.contains("browser control is owned by the CLI node-host"))
            #expect(message.contains("openclaw node start"))
        }
    }
}
