import Foundation
import Testing
@testable import OpenClaw

struct LicenseDocumentLoaderTests {
    @Test func `loads only utf8 text licenses sorted alphabetically by title`() throws {
        let directory = try Self.makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        try "Gamma License".write(
            to: directory.appendingPathComponent("Gamma.txt"),
            atomically: true,
            encoding: .utf8)
        try "Alpha License".write(
            to: directory.appendingPathComponent("Alpha.txt"),
            atomically: true,
            encoding: .utf8)
        try "Ignored".write(
            to: directory.appendingPathComponent("Beta.md"),
            atomically: true,
            encoding: .utf8)
        try "Hidden".write(
            to: directory.appendingPathComponent(".Hidden.txt"),
            atomically: true,
            encoding: .utf8)

        let documents = LicenseDocumentLoader.documents(in: directory)

        #expect(documents.map(\.filename) == ["Alpha.txt", "Gamma.txt"])
        #expect(documents.map(\.title) == ["Alpha", "Gamma"])
        #expect(documents.map(\.body) == ["Alpha License", "Gamma License"])
    }

    @Test func `derives readable titles from license filenames`() {
        #expect(LicenseDocumentLoader.title(from: "WebRTC.txt") == "WebRTC")
        #expect(LicenseDocumentLoader.title(from: "SwiftUI Siri Waveform.txt") == "SwiftUI Siri Waveform")
        #expect(LicenseDocumentLoader.title(from: "openclaw_plugin_sdk.txt") == "openclaw plugin sdk")
        #expect(LicenseDocumentLoader.title(from: "010-WebRTC.txt") == "010 WebRTC")
    }

    @Test func `bundles the waveform attribution`() {
        let waveform = LicenseDocumentLoader.bundledDocuments()
            .first { $0.filename == "SwiftUI Siri Waveform.txt" }

        #expect(waveform?.body.contains("Copyright (c) 2019 Noah Chalifour") == true)
        #expect(waveform?.body.contains("MIT License") == true)
    }

    private static func makeTemporaryDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("OpenClawLicenseDocumentLoaderTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }
}
