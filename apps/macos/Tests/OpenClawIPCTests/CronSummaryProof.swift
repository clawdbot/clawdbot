import AppKit
import ApplicationServices
import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClaw

private struct CronSummaryWirePage: Decodable {
    let jobs: [OpenClaw.CronJob]
}

/// Temporary fixture diagnostics: inspect the same bytes the socket will receive, without changing them.
nonisolated func cronSummaryWireFacts(_ response: Data) -> [String: String] {
    var facts = ["stage": "wire-validation", "phase": "response-frame"]
    facts["responseBytes"] = String(response.count)
    if response.count > 256 * 1024 {
        facts["exportOutcome"] = "over-size-limit"
    } else {
        do {
            var repository = URL(fileURLWithPath: #filePath).resolvingSymlinksInPath()
            for _ in 0..<5 {
                repository.deleteLastPathComponent()
            }
            let files = FileManager.default
            let output = repository.appendingPathComponent(".artifacts/mac-cron-summary-proof", isDirectory: true)
            guard files.fileExists(atPath: repository.appendingPathComponent("pnpm-workspace.yaml").path),
                  files.fileExists(atPath: repository.appendingPathComponent("apps/macos/Package.swift").path),
                  output.resolvingSymlinksInPath().path == output.path
            else { throw CocoaError(.fileWriteNoPermission) }
            try files.createDirectory(at: output, withIntermediateDirectories: true)
            try response.write(to: output.appendingPathComponent("response.json"), options: .withoutOverwriting)
            facts["exportOutcome"] = "written"
        } catch {
            facts["exportOutcome"] = "failed"
            facts["exportErrorCode"] = String((error as NSError).code)
        }
    }
    do {
        let frame = try JSONDecoder().decode(ResponseFrame.self, from: response)
        guard let payload = frame.payload else {
            facts["kind"] = "missing-payload"
            return facts
        }
        let raw = try JSONSerialization.jsonObject(with: response) as? [String: Any]
        let rawPayload = raw?["payload"] as? [String: Any]
        facts["wireJobs"] = (rawPayload?["jobs"] as? [Any]).map { String($0.count) } ?? "unknown"
        facts["phase"] = "payload-encoding"
        let data = try JSONEncoder().encode(payload)
        // Keep the lossy count even when strict decoding identifies the first rejected row.
        facts["phase"] = "lossy-jobs"
        facts["lossyJobs"] = try String(OpenClaw.GatewayConnection.decodeCronListResponse(data).count)
        facts["phase"] = "strict-jobs"
        facts["strictJobs"] = try String(JSONDecoder().decode(CronSummaryWirePage.self, from: data).jobs.count)
        facts["kind"] = "success"
    } catch {
        let kind: String
        let path: [any CodingKey]
        let context: DecodingError.Context?
        switch error {
        case let DecodingError.keyNotFound(key, details):
            (kind, path, context) = ("key-not-found", details.codingPath + [key], details)
        case let DecodingError.typeMismatch(_, details):
            (kind, path, context) = ("type-mismatch", details.codingPath, details)
        case let DecodingError.valueNotFound(_, details):
            (kind, path, context) = ("value-not-found", details.codingPath, details)
        case let DecodingError.dataCorrupted(details):
            (kind, path, context) = ("data-corrupted", details.codingPath, details)
        case let EncodingError.invalidValue(_, details):
            (kind, path, context) = ("invalid-encoding-value", details.codingPath, nil)
        default:
            (kind, path, context) = ("other", [], nil)
        }
        facts["kind"] = kind
        facts["codingPath"] = path.prefix(8).map(\.stringValue).joined(separator: ".")
            + (path.count > 8 ? ".<truncated>" : "")
        if let context {
            facts["decoderDescription"] = String(context.debugDescription.prefix(256))
            if let underlying = context.underlyingError as NSError?,
               let diagnostic = underlying.userInfo[NSDebugDescriptionErrorKey] as? String
            {
                facts["jsonDescription"] = String(diagnostic.prefix(256))
            }
        }
    }
    return facts
}

/// Temporary before/after proof; remove after both CI images have been exported.
@MainActor
func cronSummaryProofTexts(in row: NSView, title: String, fixtureEvents: [[String: String]]) async throws -> [String] {
    var repository = URL(fileURLWithPath: #filePath).resolvingSymlinksInPath()
    for _ in 0..<5 {
        repository.deleteLastPathComponent()
    }
    let files = FileManager.default
    try #require(files.fileExists(atPath: repository.appendingPathComponent("pnpm-workspace.yaml").path))
    try #require(files.fileExists(atPath: repository.appendingPathComponent("apps/macos/Package.swift").path))
    let output = repository.appendingPathComponent(".artifacts/mac-cron-summary-proof", isDirectory: true)
    try #require(output.resolvingSymlinksInPath().path == output.path)
    try files.createDirectory(at: output, withIntermediateDirectories: true)
    let hadWindowAtCapture = row.window != nil
    let bitmap = try #require(row.bitmapImageRepForCachingDisplay(in: row.bounds))
    row.cacheDisplay(in: row.bounds, to: bitmap)
    // The row draws text over a transparent canvas. Preserve its pixels over a light proof background.
    let context = try #require(NSGraphicsContext(bitmapImageRep: bitmap))
    context.cgContext.setBlendMode(.destinationOver)
    context.cgContext.setFillColor(NSColor.white.cgColor)
    context.cgContext.fill(CGRect(x: 0, y: 0, width: CGFloat(bitmap.pixelsWide), height: CGFloat(bitmap.pixelsHigh)))
    let png = try #require(bitmap.representation(using: .png, properties: [:]))
    try png.write(to: output.appendingPathComponent("summary.png"), options: .withoutOverwriting)

    // Use the existing AX materialization operation once; never inventory the returned windows.
    let materialization = await Task.detached {
        let application = AXUIElementCreateApplication(ProcessInfo.processInfo.processIdentifier)
        var windows: CFTypeRef?
        return AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &windows)
    }.value

    let maximumElements = 64
    let maximumChildren = 64
    let maximumDepth = 8
    let maximumTextLength = 256
    var elements: [[String: Any]] = []
    var texts: [String] = []
    var visited = Set<ObjectIdentifier>()
    var truncations = Set<String>()
    var repeatedObjects = 0
    var outsideRowObjects = 0

    func attribute(_ value: Any?) -> [String: Any] {
        guard let value else { return ["state": "unknown"] }
        let text: String
        let kind: String
        if let string = value as? String {
            text = string
            kind = "string"
        } else if let number = value as? NSNumber {
            text = number.stringValue
            kind = "number"
        } else {
            return ["state": "non-scalar"]
        }
        let prefix = text.prefix(maximumTextLength + 1)
        let truncated = prefix.count > maximumTextLength
        if truncated { truncations.insert("text") }
        return [
            "state": "observed",
            "kind": kind,
            "text": String(prefix.prefix(maximumTextLength)),
            "truncated": truncated,
        ]
    }

    func visit(_ element: AnyObject, path: String, depth: Int) {
        guard depth <= maximumDepth else {
            truncations.insert("depth")
            return
        }
        guard elements.count < maximumElements else {
            truncations.insert("elements")
            return
        }
        if element is NSWindow || element is NSApplication {
            outsideRowObjects += 1
            return
        }
        let view = element as? NSView
        if let view, view !== row, !view.isDescendant(of: row) {
            outsideRowObjects += 1
            return
        }
        guard visited.insert(ObjectIdentifier(element)).inserted else {
            repeatedObjects += 1
            return
        }
        let subviews = view?.subviews ?? []
        let children = element.accessibilityChildren?()
        let label = element.accessibilityLabel?()
        let role = element.accessibilityRole?()
        let value: Any? = element.accessibilityValue?()
        if role == .staticText, let text = value as? String { texts.append(text) }
        elements.append([
            "path": path, "depth": depth, "isView": view != nil,
            "role": attribute(role?.rawValue),
            "label": attribute(label), "title": attribute(element.accessibilityTitle?()),
            "value": attribute(value),
            "viewChildren": attribute(view.map { _ in subviews.count }),
            "accessibilityChildren": attribute(children?.count),
        ])
        if subviews.count > maximumChildren || (children?.count ?? 0) > maximumChildren {
            truncations.insert("children")
        }
        for (index, child) in subviews.prefix(maximumChildren).enumerated() {
            visit(child, path: "\(path).view[\(index)]", depth: depth + 1)
        }
        for (index, child) in (children ?? []).prefix(maximumChildren).enumerated() {
            visit(child as AnyObject, path: "\(path).ax[\(index)]", depth: depth + 1)
        }
    }
    visit(row, path: "row", depth: 0)
    let observation: [String: Any] = [
        "schemaVersion": 2, "mode": "owned-row-diagnostic", "title": attribute(title),
        "textSource": "AXStaticText.accessibilityValue", "captureBackground": "opaque-white",
        "fixtureEvents": fixtureEvents,
        "fixtureResponseMeaning": "emitted by test socket; not a delivery acknowledgement",
        "lookupPrefix": attribute("\(title), "), "rowBounds": NSStringFromRect(row.bounds),
        "rowHadWindowAtCapture": hadWindowAtCapture, "rowHasWindow": row.window != nil,
        "materializationStatus": materialization.rawValue,
        "limits": [
            "elements": maximumElements,
            "childrenPerList": maximumChildren,
            "depth": maximumDepth,
            "textCharacters": maximumTextLength,
        ],
        "truncations": truncations.sorted(), "repeatedObjectsSkipped": repeatedObjects,
        "outsideRowObjectsSkipped": outsideRowObjects, "elements": elements,
    ]
    try JSONSerialization.data(withJSONObject: observation, options: [.prettyPrinted, .sortedKeys]).write(
        to: output.appendingPathComponent("summary-label.txt"), options: .withoutOverwriting)
    try #require(materialization == .success)
    return texts
}
