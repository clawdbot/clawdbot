import Darwin
import Foundation

enum NodeHostStatsReporter {
    static let eventName = "node.host.stats"
    static let intervalSeconds: TimeInterval = 60

    struct Payload: Encodable {
        let cpuCount: Int
        let memoryTotalBytes: UInt64
        let memoryFreeBytes: UInt64
        let diskTotalBytes: Int64?
        let diskAvailableBytes: Int64?
    }

    struct Sampler {
        var cpuCount: () -> Int = { ProcessInfo.processInfo.activeProcessorCount }
        var memoryTotalBytes: () -> UInt64 = { ProcessInfo.processInfo.physicalMemory }
        var memoryFreeBytes: () throws -> UInt64 = { try NodeHostStatsReporter.sampleFreeMemory() }
        var diskCapacity: () throws -> (totalBytes: Int64?, availableBytes: Int64?) = {
            let values = try URL(fileURLWithPath: NSHomeDirectory()).resourceValues(forKeys: [
                .volumeTotalCapacityKey,
                .volumeAvailableCapacityForImportantUsageKey,
            ])
            return (values.volumeTotalCapacity.map(Int64.init), values.volumeAvailableCapacityForImportantUsage)
        }
    }

    private struct NodeEventRequestPayload: Encodable {
        let event = NodeHostStatsReporter.eventName
        let payloadJSON: String
    }

    static func makePayload(sampler: Sampler = Sampler()) throws -> Payload {
        let memoryTotalBytes = sampler.memoryTotalBytes()
        let memoryFreeBytes = try min(sampler.memoryFreeBytes(), memoryTotalBytes)
        let disk = try? sampler.diskCapacity()
        let diskTotalBytes: Int64?
        let diskAvailableBytes: Int64?
        if let total = disk?.totalBytes, let available = disk?.availableBytes {
            diskTotalBytes = max(0, total)
            diskAvailableBytes = max(0, min(available, total))
        } else {
            diskTotalBytes = nil
            diskAvailableBytes = nil
        }
        return Payload(
            cpuCount: max(1, min(4096, sampler.cpuCount())),
            memoryTotalBytes: memoryTotalBytes,
            memoryFreeBytes: memoryFreeBytes,
            diskTotalBytes: diskTotalBytes,
            diskAvailableBytes: diskAvailableBytes)
    }

    static func makeNodeEventRequestPayloadJSON(
        payload: Payload,
        encoder: JSONEncoder = JSONEncoder()) throws -> String
    {
        guard let payloadJSON = try String(data: encoder.encode(payload), encoding: .utf8),
              let requestJSON = try String(
                  data: encoder.encode(NodeEventRequestPayload(payloadJSON: payloadJSON)),
                  encoding: .utf8)
        else {
            throw EncodingError.invalidValue(payload, EncodingError.Context(
                codingPath: [],
                debugDescription: "Failed to encode node.event payload as UTF-8"))
        }
        return requestJSON
    }

    private static func sampleFreeMemory() throws -> UInt64 {
        let host = mach_host_self()
        defer { mach_port_deallocate(mach_task_self_, host) }
        var statistics = vm_statistics64_data_t()
        var count = mach_msg_type_number_t(
            MemoryLayout<vm_statistics64_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &statistics) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                host_statistics64(host, HOST_VM_INFO64, $0, &count)
            }
        }
        guard result == KERN_SUCCESS else {
            throw NSError(domain: NSMachErrorDomain, code: Int(result))
        }
        var pageSize: vm_size_t = 0
        let pageSizeResult = host_page_size(host, &pageSize)
        guard pageSizeResult == KERN_SUCCESS else {
            throw NSError(domain: NSMachErrorDomain, code: Int(pageSizeResult))
        }
        // Inactive pages are reclaimable; cap the estimate at physical memory in makePayload.
        return (UInt64(statistics.free_count) + UInt64(statistics.inactive_count)) * UInt64(pageSize)
    }
}
