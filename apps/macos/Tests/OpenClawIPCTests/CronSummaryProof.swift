import AppKit
import Foundation
import Testing

/// Temporary before/after proof; remove after both CI images have been exported.
@MainActor
func writeCronSummaryProof(_ row: NSView, label: String) throws {
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
    let bitmap = try #require(row.bitmapImageRepForCachingDisplay(in: row.bounds))
    row.cacheDisplay(in: row.bounds, to: bitmap)
    let png = try #require(bitmap.representation(using: .png, properties: [:]))
    try png.write(to: output.appendingPathComponent("summary.png"), options: .withoutOverwriting)
    try Data("\(label)\n".utf8).write(
        to: output.appendingPathComponent("summary-label.txt"), options: .withoutOverwriting)
}
