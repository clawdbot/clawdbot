import AppKit
import Foundation
import WebKit
import XCTest
@testable import OpenClaw

/// XCTest pumps the AppKit run loop across sheet dismissal; Swift Testing's
/// standalone async main exits when NSSavePanel stops that run loop.
@MainActor
final class DashboardDownloadTests: XCTestCase {
    enum Source: String, CaseIterable, Sendable {
        case http, blob, data
    }

    enum Retirement: CaseIterable {
        case reload, close, replace
    }

    func testCancellingAttachmentsKeepsDashboardUsable() async throws {
        for source in Source.allCases {
            try await self.checkCancellation(source: source)
        }
    }

    private func checkCancellation(source: Source) async throws {
        try await self.withDownload(source: source) { controller, window, dashboardURL in
            XCTAssertTrue(!controller.isShowingFailurePage)
            let panel = try XCTUnwrap(window.sheets.compactMap { $0 as? NSSavePanel }.first)
            panel.cancel(nil)
            try await self.waitUntil("Save sheet dismissed") { !window.sheets.contains(panel) }
            XCTAssertTrue(controller.webView.url == dashboardURL)
            XCTAssertTrue(!controller.isShowingFailurePage)
            let documentIntact = try await controller.webView.evaluateJavaScript(
                "document.getElementById('attachment') !== null") as? Bool
            XCTAssertEqual(documentIntact, true)
        }
    }

    func testRetiringDashboardDismissesPendingSavePanel() async throws {
        for retirement in Retirement.allCases {
            try await self.checkRetirement(retirement)
        }
    }

    private func checkRetirement(_ retirement: Retirement) async throws {
        try await self.withDownload { controller, window, _ in
            let panel = try XCTUnwrap(window.sheets.compactMap { $0 as? NSSavePanel }.first)
            switch retirement {
            case .reload:
                _ = controller.webView.reload()
            case .close:
                controller.closeDashboard()
            case .replace:
                XCTAssertTrue(controller.detachWindowForReplacement() === window)
            }
            try await self.waitUntil("retired Save sheet dismissed") { !window.sheets.contains(panel) }
            XCTAssertTrue(!controller.isShowingFailurePage)
        }
    }

    func testReplacingDashboardDismissesOldDownloadError() async throws {
        try await self.withDownload(invalidResponse: true) { controller, window, _ in
            XCTAssertTrue(!controller.isShowingFailurePage)
            let failure = try XCTUnwrap(window.sheets.first)
            XCTAssertTrue(!(failure is NSSavePanel))
            XCTAssertTrue(controller.detachWindowForReplacement() === window)
            try await self.waitUntil("retired download error dismissed") { !window.sheets.contains(failure) }
        }
    }

    private func withDownload(
        source: Source = .http,
        invalidResponse: Bool = false,
        body: @MainActor (DashboardWindowController, NSWindow, URL) async throws -> Void) async throws
    {
        _ = AppKitTestSupport.application
        let payload = "attachment download fixture"
        let filename = "attachment.docx"
        let server = try await DashboardHTTPFixture.start(
            html: """
            <!doctype html><html><head></head><body>
            <a id="attachment" href="/attachment?mediaTicket=fixture"
               download="\(filename)" target="_blank" rel="noreferrer">Download</a>
            </body></html>
            """,
            requestHandler: { request in
                guard request.hasPrefix("GET /attachment?") else { return nil }
                if invalidResponse { return "invalid HTTP response\r\n\r\n" }
                return [
                    "HTTP/1.1 200 OK",
                    "Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    "Content-Disposition: attachment; filename=\(filename)",
                    "Content-Length: \(payload.utf8.count)",
                    "Connection: close",
                    "",
                    payload,
                ].joined(separator: "\r\n")
            })
        defer { server.stop() }
        let dashboardURL = server.url("/control/")
        let controller = DashboardWindowController(
            url: dashboardURL,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        controller.show(url: dashboardURL, auth: controller.auth)
        let window = try XCTUnwrap(controller.window)
        try await self.waitUntil("Dashboard document loaded") {
            guard controller.webView.url == dashboardURL, !controller.webView.isLoading else { return false }
            return try await controller.webView.evaluateJavaScript(
                "document.getElementById('attachment') !== null") as? Bool == true
        }
        if source == .blob {
            _ = try await controller.webView.evaluateJavaScript("""
            document.getElementById('attachment').href = URL.createObjectURL(new Blob(
              ['attachment download fixture'],
              {type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}));
            null
            """)
        } else if source == .data {
            _ = try await controller.webView.evaluateJavaScript("""
            document.getElementById('attachment').href =
              'data:application/octet-stream;base64,' + btoa('attachment download fixture');
            null
            """)
        }
        _ = try await controller.webView.evaluateJavaScript("document.getElementById('attachment').click(); null")
        try await self.waitUntil("download response presented") {
            controller.isShowingFailurePage || !window.sheets.isEmpty
        }
        defer { window.close() }
        try await body(controller, window, dashboardURL)
    }

    private func waitUntil(_ description: String, _ condition: @MainActor () async throws -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(10)
        while ContinuousClock.now < deadline {
            if try await condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("The Dashboard download did not reach: \(description)")
        throw URLError(.timedOut)
    }
}
