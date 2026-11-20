import SwiftUI
import UniformTypeIdentifiers
import EACore
#if os(macOS)
import AppKit
#endif

/// Hum to MIDI on the device: sending a take, and the files handed to a DAW.
enum Hum {
    /// The button and tile that start a recording.
    static let buttonTitle = "Hum Song"
    /// Under the recorder: what to do, and what happens after.
    static let hint = "Hum, sing, tap or beatbox, up to 2 minutes. The hub hears it as a melody and as a rhythm; choose Melody, Rhythm or Both afterwards."

    /// A typed tempo the hub takes (30 to 300 BPM), or nil to let the hub find it.
    static func tempo(_ text: String) -> Double? {
        let t = text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
        guard let v = Double(t), (30...300).contains(v) else { return nil }
        return v.rounded()
    }

    /// The hub's lower-case reason as a sentence: "No notes were heard; hum a little louder or closer."
    static func sentence(_ text: String?) -> String? {
        guard let t = text?.trimmingCharacters(in: .whitespacesAndNewlines), let first = t.first else { return nil }
        let s = first.uppercased() + t.dropFirst()
        return ".!?".contains(s.last!) ? s : s + "."
    }

    /// "1:05".
    static func clock(_ t: TimeInterval) -> String {
        let s = max(0, Int(t))
        return "\(s / 60):" + String(format: "%02d", s % 60)
    }

    /// Sends a take; the idea comes back at once and goes in the local store, and the recording leaves the device.
    @MainActor
    static func send(_ take: HumTake, bpm: Double?, fromCapture: Bool, engine: SyncEngine) async throws -> Entity {
        guard let c = engine.client else { throw HubError.notConfigured }
        let e = try await c.uploadHum(fileURL: take.url, bpm: bpm, fromCapture: fromCapture, clientId: "app-\(take.id.uuidString.lowercased())")
        await engine.absorb(e)
        engine.moment(.create, kind: .music_idea)
        try? FileManager.default.removeItem(at: take.url)
        return e
    }

    /// Writes the hub's .mid to a temporary file named from the hub's name, one folder per idea and timing.
    static func write(_ m: HumMIDIFile, ideaId: String, grid: Bool, use: HumMidi.Use) throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("hum-midi", isDirectory: true)
            .appendingPathComponent(ideaId, isDirectory: true)
            .appendingPathComponent(use.rawValue, isDirectory: true)
            .appendingPathComponent(grid ? "grid" : "hummed", isDirectory: true)
        try? FileManager.default.removeItem(at: dir)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let name = grid ? m.name : (m.name as NSString).deletingPathExtension + " as hummed.mid"
        let url = dir.appendingPathComponent(name)
        // Complete protection: made for the share sheet or a drag from the open app.
        try DataProtection.write(m.data, to: url, .complete)
        return url
    }

    /// What a drag carries: the file itself and its URL, which Cubase, Ableton and the Finder all take.
    static func dragProvider(_ url: URL) -> NSItemProvider {
        let p = NSItemProvider(contentsOf: url) ?? NSItemProvider(object: url as NSURL)
        p.suggestedName = url.deletingPathExtension().lastPathComponent
        return p
    }
}

// MARK: recording

/// Elapsed time, a live level meter, Stop and Cancel.
struct HumRecordingPanel: View {
    @ObservedObject var recorder: HumRecorder

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Circle().fill(.red).frame(width: 10, height: 10)
                Text("Recording").font(.subheadline.weight(.semibold))
                Spacer()
                Text("\(Hum.clock(recorder.elapsed)) of \(Hum.clock(HumRecorder.maxSeconds))")
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            HumLevelMeter(level: recorder.level)
            HStack {
                Button(role: .cancel) { recorder.cancel() } label: { Label("Cancel", systemImage: "xmark") }
                    .buttonStyle(.bordered)
                Spacer()
                Button { recorder.stop() } label: { Label("Stop", systemImage: "stop.fill") }
                    .buttonStyle(.themedProminent)
            }
        }
        .padding(.vertical, 4)
    }
}

/// Melody, Rhythm or Both, for an idea the hub has heard; only the choices with notes are offered.
struct HumUsePicker: View {
    var midi: HumMidi
    @Binding var use: HumMidi.Use
    var body: some View {
        Picker("Use", selection: $use) {
            ForEach(HumMidi.Use.allCases.filter { midi.has($0) }, id: \.self) { Text($0.name).tag($0) }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
    }
}

struct HumLevelMeter: View {
    var level: Float

    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.secondary.opacity(0.2))
                LinearGradient(colors: [.green, .green, .yellow, .red], startPoint: .leading, endPoint: .trailing)
                    .mask(alignment: .leading) {
                        Capsule().frame(width: max(0, g.size.width * CGFloat(level)))
                    }
            }
        }
        .frame(height: 8)
        .animation(.linear(duration: 0.08), value: level)
        .accessibilityElement()
        .accessibilityLabel("Input level")
        .accessibilityValue("\(Int(level * 100)) percent")
    }
}

// MARK: piano roll

/// Time runs left to right and pitch upward: the melody's pitches, then three drum lanes (hat, snare, kick) for the
/// rhythm, as the layers in use have them. Beat lines follow the tempo, counted from the first note as the hub's grid
/// is. Long hums scroll sideways.
struct HumRoll: View {
    var midi: HumMidi
    var use: HumMidi.Use
    var bpm: Double?
    @ObservedObject var player: HumPlayer
    @State private var available: CGFloat = 300

    private let gutter: CGFloat = 40

    private enum Row: Hashable { case pitch(Int), drum(HumMidi.Drum) }

    private var rows: [Row] {
        var r: [Row] = []
        if !midi.melody(in: use).isEmpty { r += midi.pitchRange.reversed().map { .pitch($0) } }
        if !midi.rhythm(in: use).isEmpty { r += HumMidi.Drum.allCases.map { .drum($0) } }
        return r
    }

    /// The melody keeps its height; the drum lanes add a little under it.
    private var height: CGFloat {
        let m: CGFloat = midi.melody(in: use).isEmpty ? 0 : 200
        let d: CGFloat = midi.rhythm(in: use).isEmpty ? 0 : (m > 0 ? 66 : 200)
        return max(80, m + d)
    }

    var body: some View {
        let length = max(midi.length(in: use), 1)
        // About 50 points a second, never narrower than the screen, and capped so a long hum stays a light drawing.
        let width = min(max(available, CGFloat(length) * 50), 2400)
        HStack(spacing: 0) {
            Canvas { ctx, size in drawLabels(&ctx, size) }
                .frame(width: gutter, height: height)
            ScrollView(.horizontal) {
                ZStack(alignment: .topLeading) {
                    Canvas { ctx, size in drawNotes(&ctx, size, length: length) }
                    if player.playing == .notes, let start = player.startedAt {
                        TimelineView(.animation) { tl in
                            let x = CGFloat(tl.date.timeIntervalSince(start) / length) * width
                            Rectangle().fill(Color.accentColor).frame(width: 2, height: height).offset(x: min(x, width - 2))
                        }
                    }
                }
                .frame(width: width, height: height)
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { available = $0 }
        }
        .frame(height: height)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .accessibilityElement()
        .accessibilityLabel(use == .rhythm ? "Rhythm lanes" : use == .melody ? "Piano roll" : "Piano roll and rhythm lanes")
        .accessibilityValue(midi.countText(in: use))
    }

    /// Each melody row and each drum lane gets its share of its own part of the height.
    private func frames(_ size: CGSize) -> [Row: CGRect] {
        let pitches = rows.filter { if case .pitch = $0 { return true } else { return false } }
        let drums = rows.filter { if case .drum = $0 { return true } else { return false } }
        let drumPart = drums.isEmpty ? 0 : (pitches.isEmpty ? size.height : size.height * 66 / 266)
        let melodyPart = size.height - drumPart
        var out: [Row: CGRect] = [:]
        let ph = melodyPart / CGFloat(max(1, pitches.count))
        for (i, r) in pitches.enumerated() { out[r] = CGRect(x: 0, y: CGFloat(i) * ph, width: size.width, height: ph) }
        let dh = drumPart / CGFloat(max(1, drums.count))
        for (i, r) in drums.enumerated() { out[r] = CGRect(x: 0, y: melodyPart + CGFloat(i) * dh, width: size.width, height: dh) }
        return out
    }

    private func drawLabels(_ ctx: inout GraphicsContext, _ size: CGSize) {
        let f = frames(size)
        let pitchCount = rows.filter { if case .pitch = $0 { return true } else { return false } }.count
        for r in rows {
            guard let box = f[r] else { continue }
            let label: String?
            switch r {
            case .drum(let d): label = d.name
            case .pitch(let p): label = p % 12 == 0 || pitchCount <= 16 ? HumMidi.noteName(p) : nil
            }
            guard let label else { continue }
            ctx.draw(Text(label).font(.system(size: min(11, max(8, box.height * 0.8)))).foregroundColor(.secondary),
                     at: CGPoint(x: 4, y: box.midY), anchor: .leading)
        }
    }

    private func drawNotes(_ ctx: inout GraphicsContext, _ size: CGSize, length: Double) {
        let f = frames(size)
        let perSecond = size.width / CGFloat(length)
        // Black keys and every other drum lane are shaded, so a row is easy to follow across.
        for r in rows {
            guard let box = f[r] else { continue }
            let shaded: Bool
            switch r {
            case .drum(let d): shaded = d.rawValue % 2 == 1
            case .pitch(let p): shaded = [1, 3, 6, 8, 10].contains(p % 12)
            }
            if shaded { ctx.fill(Path(box), with: .color(.secondary.opacity(0.08))) }
        }
        // A line between the melody and the drums.
        if let firstDrum = f[.drum(.hat)], firstDrum.minY > 0 {
            ctx.fill(Path(CGRect(x: 0, y: firstDrum.minY - 0.5, width: size.width, height: 1)), with: .color(.secondary.opacity(0.4)))
        }
        if let bpm, bpm > 0 {
            let beat = 60 / bpm
            var n = 0
            var t = 0.0
            while t <= length {
                let x = CGFloat(t) * perSecond
                ctx.fill(Path(CGRect(x: x, y: 0, width: n % 4 == 0 ? 1 : 0.5, height: size.height)),
                         with: .color(.secondary.opacity(n % 4 == 0 ? 0.35 : 0.15)))
                n += 1
                t = Double(n) * beat
            }
        }
        func draw(_ note: HumMidi.Note, _ row: Row, minWidth: CGFloat) {
            guard let box = f[row] else { return }
            let x = CGFloat(note.s) * perSecond
            let w = max(minWidth, CGFloat(note.d) * perSecond - 1)
            let rect = CGRect(x: x, y: box.minY + 1, width: w, height: max(2, box.height - 2))
            ctx.fill(Path(roundedRect: rect, cornerRadius: min(3, box.height / 3)), with: .color(Color.accentColor.opacity(0.45 + 0.55 * Double(note.v) / 127)))
        }
        for note in midi.melody(in: use) { draw(note, .pitch(note.p), minWidth: 3) }
        for note in midi.rhythm(in: use) { draw(note, .drum(HumMidi.drum(note.p)), minWidth: 5) }
    }
}

// MARK: a hummed idea

/// What a music idea made from a hum shows: Listening until the notes arrive (or why it failed), then Melody, Rhythm
/// or Both, the piano roll and drum lanes, playing, the MIDI file for a DAW, and hearing the recording again at a set
/// tempo.
struct HumIdeaSections: View {
    @EnvironmentObject var engine: SyncEngine
    var idea: Entity
    var midi: HumMidi
    /// Owned by the idea's screen, so playing stops when that screen goes, not when a row scrolls away.
    @ObservedObject var player: HumPlayer

    @State private var grid = true
    @State private var file: URL?
    /// What the current file was made from: the notes and timing, then also the title and tempo.
    @State private var fileFor: String?
    @State private var fileKeyDone: String?
    @State private var fileError: String?
    @State private var fileTry = 0
    @State private var recording: Data?
    @State private var loadingRecording = false
    @State private var tempo = ""
    @State private var busy = false
    @State private var error: String?

    private var heard: Bool { midi.state == .done && midi.heard }
    private var bpm: Double? { idea.number("bpm") }
    /// Melody, Rhythm or Both: the owner's choice when it has notes, else both or the one heard.
    private var use: HumMidi.Use { midi.use(idea.string("hum_use")) }

    /// The hub's file follows the notes, the layers in use, the timing choice, the title (its name) and the tempo.
    private var fileKey: String {
        "\(idea.id)|\(use.rawValue)|\(grid)|\(idea.field_ts["midi"] ?? "")|\(idea.str("title"))|\(bpm.map { Making.num($0) } ?? "")|\(fileTry)"
    }

    /// Kept like any other field of the idea: it syncs, and waits in the outbox while the hub is out of reach.
    private var useBinding: Binding<HumMidi.Use> {
        Binding(get: { use }, set: { u in
            player.stop()
            Task { _ = await engine.update(idea.id, fields: ["hum_use": .string(u.rawValue)]) }
        })
    }

    var body: some View {
        SwiftUI.Section {
            switch midi.state {
            case .listening: listening
            case .failed: failed
            case .done: if heard { notes } else { failed }
            }
            if let e = error { MakingErrorLine(text: e) }
        } header: {
            Text(midi.kindName)
        }

        if heard {
            SwiftUI.Section {
                export
            } header: {
                Text("MIDI for your DAW")
            } footer: {
                #if os(macOS)
                Text("Drag the file onto a MIDI track in Cubase or Ableton, or save it. Snapped puts every note on the nearest 1/16.")
                #else
                Text("AirDrop it to the Mac or save it to Files, then drag it onto a MIDI track. Snapped puts every note on the nearest 1/16.")
                #endif
            }
            .task(id: fileKey) { await loadFile() }
        }

        if midi.state != .listening {
            SwiftUI.Section {
                LabeledContent("Tempo") {
                    HStack(spacing: 8) {
                        TextField(bpm.map { Making.num($0) } ?? "BPM", text: $tempo)
                            .multilineTextAlignment(.trailing)
                            .font(.body.monospaced())
                            .numericKeyboard()
                            .frame(maxWidth: 90)
                        Button("Hear again") { Task { await rehear(bpm: Hum.tempo(tempo)) } }
                            .buttonStyle(.borderless)
                            .disabled(busy || Hum.tempo(tempo) == nil)
                    }
                }
            } header: {
                Text("Hear it again")
            } footer: {
                Text("The hub listens to the kept recording again. Type a tempo from 30 to 300 to set it; leave it empty and the hub finds one.")
            }
        }
    }

    private var listening: some View {
        HStack(spacing: 12) {
            ProgressView()
            VStack(alignment: .leading, spacing: 2) {
                Text("Listening")
                Text("The hub is hearing the notes and the hits. This takes about \(Int(((midi.seconds ?? 10) * 1.2).rounded(.up)) + 3) seconds.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }

    private var failed: some View {
        VStack(alignment: .leading, spacing: 10) {
            MakingErrorLine(text: StyleGuard.dashes(Hum.sentence(midi.error) ?? "The hub could not hear it."))
            recordingButton
        }
        .padding(.vertical, 4)
    }

    private var notes: some View {
        VStack(alignment: .leading, spacing: 10) {
            if midi.has(.both) { HumUsePicker(midi: midi, use: useBinding) }
            HumRoll(midi: midi, use: use, bpm: bpm, player: player)
            HStack(spacing: 14) {
                if use != .rhythm, let k = idea.string("key"), !k.isEmpty { Text(k) }
                if let b = bpm { Text("\(Making.num(b)) BPM") }
                Text(midi.countText(in: use))
            }
            .font(.callout.monospaced())
            .foregroundStyle(.secondary)
            HStack(spacing: 10) {
                Button {
                    if player.playing == .notes { player.stop() } else { player.playNotes(midi, use: use) }
                } label: {
                    Label(player.playing == .notes ? "Stop" : "Play", systemImage: player.playing == .notes ? "stop.fill" : "play.fill")
                }
                .buttonStyle(.themedProminent)
                recordingButton
            }
            if let e = player.error { MakingErrorLine(text: e) }
        }
        .padding(.vertical, 4)
    }

    private var recordingButton: some View {
        HStack(spacing: 8) {
            Button { Task { await toggleRecording() } } label: {
                Label(player.playing == .recording ? "Stop" : "Play the recording", systemImage: player.playing == .recording ? "stop.fill" : "waveform")
            }
            .buttonStyle(.bordered)
            .disabled(loadingRecording)
            if loadingRecording { ProgressView().controlSize(.small) }
        }
    }

    @ViewBuilder private var export: some View {
        Picker("Timing", selection: $grid) {
            Text("Snapped to the grid").tag(true)
            Text("As hummed").tag(false)
        }
        if let url = file {
            #if os(macOS)
            HStack(spacing: 12) {
                HumDragChip(url: url)
                Spacer()
                Button { save(url) } label: { Label("Save MIDI", systemImage: "square.and.arrow.down") }
            }
            #else
            ShareLink(item: url, preview: SharePreview(url.lastPathComponent)) {
                Label("Export MIDI", systemImage: "square.and.arrow.up")
            }
            #endif
        } else if let e = fileError {
            MakingErrorLine(text: e)
            Button("Try again") { fileTry += 1 }
        } else {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Making the MIDI file").foregroundStyle(.secondary)
            }
        }
    }

    private func loadFile() async {
        // New notes or another timing swap the file at once, so the old one is never dragged by mistake. A title
        // or tempo edit keeps the file it has and waits a moment, so the edit reaches the hub first.
        // A list row that scrolls back into view starts this again; the file it has is still right.
        if fileKeyDone == fileKey, file != nil { return }
        let key = fileKey
        let made = "\(idea.id)|\(use.rawValue)|\(grid)|\(idea.field_ts["midi"] ?? "")"
        let sameNotes = fileFor == made
        if !sameNotes { file = nil }
        fileError = nil
        if sameNotes, file != nil {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            if Task.isCancelled { return }
        }
        guard let c = engine.client else { fileError = "Connect to the hub to get the MIDI file."; return }
        do {
            let m = try await c.humMIDI(idea.id, grid: grid, use: use)
            if Task.isCancelled { return }
            file = try Hum.write(m, ideaId: idea.id, grid: grid, use: use)
            fileFor = made
            fileKeyDone = key
        } catch {
            if !Task.isCancelled { fileError = Making.message(error) }
        }
    }

    private func toggleRecording() async {
        if player.playing == .recording { player.stop(); return }
        if recording == nil {
            guard let c = engine.client else { error = "Connect to the hub to play the recording."; return }
            loadingRecording = true
            defer { loadingRecording = false }
            do { recording = try await c.humRecording(idea.id) }
            catch { self.error = Making.message(error); return }
        }
        if let d = recording { player.playRecording(d) }
    }

    private func rehear(bpm: Double?) async {
        guard let c = engine.client else { error = "Connect to the hub to hear it again."; return }
        busy = true
        defer { busy = false }
        error = nil
        player.stop()
        do {
            let e = try await c.rehearHum(idea.id, bpm: bpm)
            await engine.absorb(e)
            tempo = ""
        } catch {
            self.error = Making.message(error)
        }
    }

    #if os(macOS)
    private func save(_ url: URL) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = url.lastPathComponent
        panel.allowedContentTypes = [.midi]
        panel.canCreateDirectories = true
        panel.begin { response in
            guard response == .OK, let dest = panel.url else { return }
            // Written in place: a sandboxed app may write only the file that was picked, not a temporary file beside it.
            do { try Data(contentsOf: url).write(to: dest) }
            catch { Task { @MainActor in fileError = "Could not save the MIDI file: \(error.localizedDescription)" } }
        }
    }
    #endif
}

#if os(macOS)
/// The .mid as a chip to drag straight onto a DAW track.
struct HumDragChip: View {
    var url: URL
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "pianokeys")
            Text(url.lastPathComponent).lineLimit(1).truncationMode(.middle)
        }
        .font(.callout)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.tint.opacity(0.15), in: RoundedRectangle(cornerRadius: 8))
        .onDrag { Hum.dragProvider(url) }
        .help("Drag onto a MIDI track in your DAW")
        .accessibilityLabel("MIDI file \(url.lastPathComponent), drag onto a track")
    }
}
#endif
