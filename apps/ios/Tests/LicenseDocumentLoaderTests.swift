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

    @Test func `bundles third party attributions`() throws {
        let documents = LicenseDocumentLoader.bundledDocuments()
        let expected = [
            ("SwiftUI Siri Waveform.txt", "Copyright (c) 2019 Noah Chalifour", "MIT License"),
            ("Mermaid.txt", "Copyright (c) 2014 - 2022 Knut Sveidqvist", "MIT License"),
            ("DOMPurify.txt", "Mozilla Public License Version 2.0", "Apache License"),
            ("JamaJS.txt", "https://github.com/dragonfly-ai/JamaJS", "Apache License"),
        ]
        for (filename, attribution, license) in expected {
            let document = try #require(documents.first { $0.filename == filename })
            #expect(document.body.contains(attribution))
            #expect(document.body.contains(license))
        }
    }

    private static func makeTemporaryDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("OpenClawLicenseDocumentLoaderTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }
}
