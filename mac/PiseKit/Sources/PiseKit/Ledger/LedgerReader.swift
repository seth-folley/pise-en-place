import Foundation

private struct LedgerVersion: Decodable { let version: Int }

// This actor owns blocking file I/O and decoding, never UI state. Value snapshots
// cross the boundary; raw lines and paths are not logged or persisted elsewhere.
actor LedgerReader {
    private let paths: LedgerPaths
    private var snapshot = LedgerSnapshot()

    func report(query: ReportQuery, reload: Bool) throws -> DashboardReport {
        if reload || snapshot.loadedAt == nil { snapshot = try load() }
        return try Reports.build(snapshot, query: query)
    }

    init(paths: LedgerPaths = .live) { self.paths = paths }

    func load() throws -> LedgerSnapshot {
        let usage: LedgerResult<UsageRecord> = try Self.read(paths.usage)
        let skills: LedgerResult<SkillRecord> = try Self.read(paths.skills)
        return LedgerSnapshot(usage: usage, skills: skills, loadedAt: Date())
    }

    static func read<Record: LedgerEntry>(_ url: URL) throws -> LedgerResult<Record> {
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            let error = error as NSError
            var status = LedgerStatus()
            if error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError {
                status.missing = true
            } else {
                status.error = error.localizedDescription
            }
            return LedgerResult(status: status)
        }
        return try parse(data)
    }

    static func parse<Record: LedgerEntry>(_ data: Data) throws -> LedgerResult<Record> {
        var result = LedgerResult<Record>()
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let value = try decoder.singleValueContainer().decode(String.self)
            if let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value) { return date }
            if let date = try? Date.ISO8601FormatStyle().parse(value) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Invalid ISO timestamp"))
        }
        // Only newline-terminated records are committed. Keep even invalid UTF-8
        // isolated to one line; a concurrent writer's trailing fragment is deferred.
        let lines = data.split(separator: 0x0A, omittingEmptySubsequences: false)
        for (index, bytes) in lines.enumerated() {
            if index % 256 == 0 { try Task.checkCancellation() }
            if index == lines.count - 1 {
                result.status.pendingTail = bytes.contains { ![0x20, 0x09, 0x0D].contains($0) }
                break
            }
            if bytes.allSatisfy({ [0x20, 0x09, 0x0D].contains($0) }) { continue }
            do {
                let line = Data(bytes)
                let header = try decoder.decode(LedgerVersion.self, from: line)
                guard header.version == 1 else {
                    result.status.unsupported += 1
                    continue
                }
                let record = try decoder.decode(Record.self, from: line)
                guard record.isValid else { result.status.malformed += 1; continue }
                // Match /usage: do not silently deduplicate existing ledger rows.
                result.records.append(record)
            } catch {
                result.status.malformed += 1
            }
        }
        return result
    }
}
