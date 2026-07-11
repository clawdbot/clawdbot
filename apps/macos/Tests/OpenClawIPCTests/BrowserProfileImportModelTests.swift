import Foundation
import Testing
@testable import OpenClaw

@MainActor
private final class ContinuationBox {
    var continuation: CheckedContinuation<Void, Never>?
}

@MainActor
private final class BrowserImportTransportStub {
    struct StubError: Error, LocalizedError {
        var errorDescription: String? {
            "boom"
        }
    }

    var requests: [BrowserProfileImportRequest] = []
    var failingPaths: Set<String> = []
    var beforeStatusResponse: (@MainActor () async -> Void)?
    var statusJSON = """
    {
      "enabled": true,
      "systemProfiles": [
        { "browser": "chrome", "id": "Default", "name": "Personal", "hasCookies": true }
      ],
      "state": null,
      "suggestedTarget": "imported"
    }
    """

    func makeModel(isLocalMode: @escaping @MainActor () -> Bool = { true }) -> BrowserProfileImportModel {
        BrowserProfileImportModel(
            transport: { [weak self] request in
                guard let self else { throw StubError() }
                self.requests.append(request)
                if request.path == "/system-profile-import/status", let hook = self.beforeStatusResponse {
                    self.beforeStatusResponse = nil
                    await hook()
                }
                if self.failingPaths.contains(request.path) {
                    throw StubError()
                }
                switch request.path {
                case "/system-profile-import/status":
                    return Data(self.statusJSON.utf8)
                case "/profiles/import":
                    return Data(#"{"into":"imported","cookies":{"total":412,"imported":409}}"#.utf8)
                default:
                    return Data(#"{"ok":true}"#.utf8)
                }
            },
            isOnboarded: { true },
            isLocalMode: isLocalMode)
    }

    func requests(for path: String) -> [BrowserProfileImportRequest] {
        self.requests.filter { $0.path == path }
    }
}

@MainActor
struct BrowserProfileImportModelTests {
    private static func status(
        profiles: [BrowserSystemProfile],
        enabled: Bool = true,
        state: BrowserProfileImportOutcome? = nil) -> BrowserProfileImportStatus
    {
        BrowserProfileImportStatus(
            enabled: enabled,
            systemProfiles: profiles,
            state: state,
            suggestedTarget: "imported")
    }

    private static let chromeProfile = BrowserSystemProfile(
        browser: "chrome",
        id: "Default",
        name: "Personal",
        hasCookies: true)

    @Test func `automatic offer requires importable cookies and no prior outcome`() {
        let fresh = Self.status(profiles: [Self.chromeProfile])
        #expect(BrowserProfileImportModel.shouldOffer(status: fresh, force: false))

        let dismissed = Self.status(
            profiles: [Self.chromeProfile],
            state: BrowserProfileImportOutcome(status: .dismissed))
        #expect(!BrowserProfileImportModel.shouldOffer(status: dismissed, force: false))
        #expect(BrowserProfileImportModel.shouldOffer(status: dismissed, force: true))
    }

    @Test func `profiles without cookies do not trigger import`() {
        let status = Self.status(profiles: [
            BrowserSystemProfile(browser: "brave", id: "Default", name: "Default", hasCookies: false),
        ])
        #expect(!BrowserProfileImportModel.shouldOffer(status: status, force: true))
    }

    @Test func `disabled import never offers`() {
        let status = Self.status(profiles: [Self.chromeProfile], enabled: false)
        #expect(!BrowserProfileImportModel.shouldOffer(status: status, force: true))
    }

    @Test func `refresh publishes the offer banner`() async {
        let stub = BrowserImportTransportStub()
        let model = stub.makeModel()
        let outcome = await model.refresh(force: false)
        #expect(outcome == .offering)
        guard case let .offering(status) = model.phase else {
            Issue.record("expected offering phase, got \(model.phase)")
            return
        }
        #expect(status.importableProfiles == [Self.chromeProfile])
    }

    @Test func `remote gateways hide the banner and report local-mode requirement`() async {
        let stub = BrowserImportTransportStub()
        let model = stub.makeModel(isLocalMode: { false })
        let outcome = await model.refresh(force: true)
        #expect(outcome == .unavailable(
            title: "Browser import requires Local mode",
            message: "Switch this Mac app to a local Gateway before importing browser cookies."))
        #expect(model.phase == .hidden)
        #expect(stub.requests.isEmpty)
    }

    @Test func `import success records counts and target`() async throws {
        let stub = BrowserImportTransportStub()
        let model = stub.makeModel()
        await model.refresh(force: false)
        await model.importProfile(Self.chromeProfile)

        let expected = BrowserProfileImportResult(
            into: "imported",
            cookies: BrowserProfileImportResult.Counts(total: 412, imported: 409))
        #expect(model.phase == .imported(expected))

        let importRequest = try #require(stub.requests(for: "/profiles/import").first)
        #expect(importRequest.method == "POST")
        #expect(importRequest.timeoutMs == 120_000)
        let body = try #require(importRequest.body)
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any]
        #expect(object?["browser"] as? String == "chrome")
        #expect(object?["systemProfile"] as? String == "Default")
        #expect(object?["into"] as? String == "imported")
        #expect(object?["makeDefault"] as? Bool == true)
    }

    @Test func `import failure keeps a retry path`() async {
        let stub = BrowserImportTransportStub()
        stub.failingPaths = ["/profiles/import"]
        let model = stub.makeModel()
        await model.refresh(force: false)
        await model.importProfile(Self.chromeProfile)

        guard case let .failed(message, retry) = model.phase else {
            Issue.record("expected failed phase, got \(model.phase)")
            return
        }
        #expect(message == "boom")
        #expect(retry.suggestedTarget == "imported")

        model.retry()
        #expect(model.phase == .offering(retry))
    }

    @Test func `dismissing an offer persists the dismissal`() async {
        let stub = BrowserImportTransportStub()
        let model = stub.makeModel()
        await model.refresh(force: false)
        model.dismiss()
        #expect(model.phase == .hidden)
        for _ in 0..<200 where stub.requests(for: "/system-profile-import/dismiss").isEmpty {
            await Task.yield()
        }
        let dismissals = stub.requests(for: "/system-profile-import/dismiss")
        #expect(dismissals.count == 1)
        #expect(dismissals.first?.method == "POST")
    }

    @Test func `dismissing a result banner does not overwrite the recorded outcome`() async {
        let stub = BrowserImportTransportStub()
        let model = stub.makeModel()
        await model.refresh(force: false)
        await model.importProfile(Self.chromeProfile)
        model.dismiss()
        #expect(model.phase == .hidden)
        for _ in 0..<50 {
            await Task.yield()
        }
        #expect(stub.requests(for: "/system-profile-import/dismiss").isEmpty)
    }

    @Test func `stale idle poll never clobbers a phase set while it was in flight`() async {
        let stub = BrowserImportTransportStub()
        let model = stub.makeModel()
        let gate = ContinuationBox()
        stub.beforeStatusResponse = {
            await withCheckedContinuation { gate.continuation = $0 }
        }

        let idle = Task { await model.refreshIfIdle() }
        while gate.continuation == nil {
            await Task.yield()
        }

        // A forced Settings offer lands while the idle poll is suspended.
        let forced = Self.status(
            profiles: [Self.chromeProfile],
            state: BrowserProfileImportOutcome(status: .dismissed))
        model._testSetPhase(.offering(forced))

        gate.continuation?.resume()
        _ = await idle.value
        #expect(model.phase == .offering(forced))
    }

    @Test func `dismissal suppresses automatic re-offers for the session`() async {
        let stub = BrowserImportTransportStub()
        let model = stub.makeModel()
        await model.refresh(force: false)
        model.dismiss()
        #expect(model.phase == .hidden)

        // The persistence write may still be pending or lost; the server keeps
        // reporting an importable profile, but automatic polls must not re-offer.
        let statusPolls = stub.requests(for: "/system-profile-import/status").count
        let refreshed = await model.refreshIfIdle()
        #expect(!refreshed)
        #expect(stub.requests(for: "/system-profile-import/status").count == statusPolls)
        #expect(model.phase == .hidden)

        // Settings force-refresh still overrides the session suppression.
        let outcome = await model.refresh(force: true)
        #expect(outcome == .offering)
    }

    @Test func `stale idle poll does not resurrect a dismissed offer`() async {
        let stub = BrowserImportTransportStub()
        let model = stub.makeModel()
        let gate = ContinuationBox()
        stub.beforeStatusResponse = {
            await withCheckedContinuation { gate.continuation = $0 }
        }

        let idle = Task { await model.refreshIfIdle() }
        while gate.continuation == nil {
            await Task.yield()
        }

        // A faster poll offered the banner and the user dismissed it while the
        // slow poll was still waiting on its (pre-dismissal) status payload.
        model._testSetPhase(.offering(Self.status(profiles: [Self.chromeProfile])))
        model.dismiss()
        #expect(model.phase == .hidden)

        gate.continuation?.resume()
        _ = await idle.value
        #expect(model.phase == .hidden)
    }

    @Test func `idle refresh never clobbers a visible outcome`() async {
        let stub = BrowserImportTransportStub()
        let model = stub.makeModel()
        await model.refresh(force: false)
        await model.importProfile(Self.chromeProfile)
        let requestCount = stub.requests.count

        let refreshed = await model.refreshIfIdle()
        #expect(!refreshed)
        #expect(stub.requests.count == requestCount)
        guard case .imported = model.phase else {
            Issue.record("expected imported phase, got \(model.phase)")
            return
        }
    }
}

@MainActor
struct BrowserProfileImportBannerContentTests {
    @Test func `offering banner lists distinct browsers and offers all profiles`() throws {
        let profiles = [
            BrowserSystemProfile(browser: "chrome", id: "Default", name: "Personal", hasCookies: true),
            BrowserSystemProfile(browser: "chrome", id: "Profile 1", name: "Work", hasCookies: true),
            BrowserSystemProfile(browser: "brave", id: "Default", name: "Default", hasCookies: true),
        ]
        let status = BrowserProfileImportStatus(
            enabled: true,
            systemProfiles: profiles,
            state: nil,
            suggestedTarget: "imported")
        let content = try #require(BrowserProfileImportBannerContent.content(for: .offering(status)))
        #expect(content.title == "Use your browser logins")
        #expect(content.subtitle.contains("Chrome and Brave"))
        #expect(content.badge == .globe)
        #expect(content.action == .importProfiles(profiles))
    }

    @Test func `result banners carry counts and errors`() throws {
        let result = BrowserProfileImportResult(
            into: "imported",
            cookies: BrowserProfileImportResult.Counts(total: 10, imported: 9))
        let success = try #require(BrowserProfileImportBannerContent.content(for: .imported(result)))
        #expect(success.subtitle.contains("9 of 10 cookies"))
        #expect(success.badge == .success)
        #expect(success.action == .none)

        let status = BrowserProfileImportStatus(
            enabled: true,
            systemProfiles: [],
            state: nil,
            suggestedTarget: "imported")
        let failure = try #require(BrowserProfileImportBannerContent.content(
            for: .failed(message: "boom", retry: status)))
        #expect(failure.subtitle == "boom")
        #expect(failure.badge == .failure)
        #expect(failure.action == .retry)

        #expect(BrowserProfileImportBannerContent.content(for: .hidden) == nil)
    }
}
