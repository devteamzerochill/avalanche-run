// Frame-exact gameplay video recorder (macOS, no dependencies).
//
// Loads the game in record mode in a WebKit view, runs the scripted scenario
// (tools/record-scenario.js), steps the virtual clock one frame at a time,
// snapshots every frame and encodes H.264 at a true 60 fps; the game's audio
// is rendered offline in lockstep and muxed in as AAC.
//
//   swiftc -O tools/record.swift -o build/record
//   build/record --url "http://localhost:8123/dist/web/index.html?record&seed=777" \
//                --out avalanche-run-gameplay.mp4 --seconds 60 --width 1080 --height 1920
import AppKit
import AVFoundation
import WebKit

struct Opts {
  var url = "http://localhost:8123/dist/web/index.html?record&seed=777"
  var out = "avalanche-run-gameplay.mp4"
  var seconds = 60.0
  var fps = 60
  var width = 1080
  var height = 1920
  var scale = 2
  var scenario = "tools/record-scenario.js"
  var scenarioOpts = "{}"
}

var opts = Opts()
var args = CommandLine.arguments.dropFirst().makeIterator()
while let a = args.next() {
  switch a {
  case "--url": opts.url = args.next()!
  case "--out": opts.out = args.next()!
  case "--seconds": opts.seconds = Double(args.next()!)!
  case "--fps": opts.fps = Int(args.next()!)!
  case "--width": opts.width = Int(args.next()!)!
  case "--height": opts.height = Int(args.next()!)!
  case "--scale": opts.scale = Int(args.next()!)!
  case "--scenario": opts.scenario = args.next()!
  case "--scenario-opts": opts.scenarioOpts = args.next()!
  default: fatalError("unknown option \(a)")
  }
}

func log(_ s: String) {
  FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
}

@MainActor
final class Recorder: NSObject, WKNavigationDelegate {
  let window: NSWindow
  let web: WKWebView
  var loaded: CheckedContinuation<Void, Never>?

  override init() {
    let w = CGFloat(opts.width / opts.scale)
    let h = CGFloat(opts.height / opts.scale)
    window = NSWindow(contentRect: NSRect(x: 40, y: 40, width: w, height: h), styleMask: [.borderless], backing: .buffered, defer: false)
    let cfg = WKWebViewConfiguration()
    cfg.websiteDataStore = .nonPersistent()
    cfg.mediaTypesRequiringUserActionForPlayback = []
    if #available(macOS 14.0, *) { cfg.preferences.inactiveSchedulingPolicy = .none }
    web = WKWebView(frame: NSRect(x: 0, y: 0, width: w, height: h), configuration: cfg)
    super.init()
    web.navigationDelegate = self
    window.contentView = web
    window.alphaValue = 0.02 // effectively invisible, but still composited
    window.ignoresMouseEvents = true
    window.level = .normal
    window.orderBack(nil)
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    loaded?.resume()
    loaded = nil
  }

  func js(_ code: String) async throws -> Any? {
    try await web.callAsyncJavaScript(code, arguments: [:], in: nil, contentWorld: .page)
  }

  func run() async throws {
    await withCheckedContinuation { c in
      loaded = c
      web.load(URLRequest(url: URL(string: opts.url)!))
    }
    // Wait for the game to boot and its sounds to decode.
    for _ in 0..<200 {
      if let ok = try await js("return !!(window.__GAME && window.__REC)") as? Bool, ok { break }
      try await Task.sleep(nanoseconds: 50_000_000)
    }
    let scenario = try String(contentsOfFile: opts.scenario, encoding: .utf8)
    _ = try await js("window.__SCENARIO = \(opts.scenarioOpts); " + scenario + "; return true")
    for _ in 0..<200 {
      if let n = try await js("return Object.keys(__GAME.game.audio.buffers).length") as? Int, n >= 8 { break }
      try await Task.sleep(nanoseconds: 50_000_000)
    }

    let videoURL = URL(fileURLWithPath: opts.out + ".video.mp4")
    try? FileManager.default.removeItem(at: videoURL)
    let writer = try AVAssetWriter(outputURL: videoURL, fileType: .mp4)
    let vin = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: opts.width,
      AVVideoHeightKey: opts.height,
      AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: opts.width * opts.height * 10,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
        AVVideoMaxKeyFrameIntervalKey: opts.fps,
        AVVideoExpectedSourceFrameRateKey: opts.fps,
      ],
    ])
    vin.expectsMediaDataInRealTime = false
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: vin, sourcePixelBufferAttributes: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
      kCVPixelBufferWidthKey as String: opts.width,
      kCVPixelBufferHeightKey as String: opts.height,
    ])
    writer.add(vin)
    writer.startWriting()
    writer.startSession(atSourceTime: .zero)

    let frames = Int(opts.seconds * Double(opts.fps))
    let snap = WKSnapshotConfiguration()
    snap.afterScreenUpdates = true
    snap.snapshotWidth = NSNumber(value: opts.width / opts.scale)
    let t0 = Date()
    for f in 0..<frames {
      _ = try await js("return await __REC.step()")
      let img = try await web.takeSnapshot(configuration: snap)
      guard let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { fatalError("no snapshot") }
      while !vin.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 2_000_000) }
      guard let pool = adaptor.pixelBufferPool else { fatalError("no pool") }
      var pb: CVPixelBuffer?
      CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pb)
      let buf = pb!
      CVPixelBufferLockBaseAddress(buf, [])
      let ctx = CGContext(data: CVPixelBufferGetBaseAddress(buf), width: opts.width, height: opts.height, bitsPerComponent: 8,
                          bytesPerRow: CVPixelBufferGetBytesPerRow(buf), space: CGColorSpace(name: CGColorSpace.sRGB)!,
                          bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
      ctx.interpolationQuality = .high
      ctx.draw(cg, in: CGRect(x: 0, y: 0, width: opts.width, height: opts.height))
      CVPixelBufferUnlockBaseAddress(buf, [])
      adaptor.append(buf, withPresentationTime: CMTime(value: CMTimeValue(f), timescale: CMTimeScale(opts.fps)))
      if f % 300 == 0 {
        let st = (try? await js("return __GAME.game.state")) as? String ?? "?"
        log(String(format: "frame %d/%d  %.0fs  state=%@  (%.1f s elapsed)", f, frames, Double(f) / Double(opts.fps), st, Date().timeIntervalSince(t0)))
      }
    }
    vin.markAsFinished()
    await writer.finishWriting()
    if writer.status != .completed { fatalError("video write failed: \(String(describing: writer.error))") }
    let timeline = (try? await js("return JSON.stringify(window.__RECLOG)")) as? String ?? ""
    log("timeline \(timeline)")

    // Audio: finish the offline render and pull the WAV out in chunks.
    let wavURL = URL(fileURLWithPath: opts.out + ".audio.wav")
    let len = try await js("return await __REC.finish(\(opts.seconds))") as? Int ?? 0
    var b64 = ""
    let chunk = 4_000_000
    var i = 0
    while i * chunk < len {
      b64 += (try await js("return __REC.chunk(\(i), \(chunk))") as? String) ?? ""
      i += 1
    }
    try Data(base64Encoded: b64)!.write(to: wavURL)
    log("audio \(len) base64 chars")

    try await mux(video: videoURL, audio: wavURL, out: URL(fileURLWithPath: opts.out))
    try? FileManager.default.removeItem(at: videoURL)
    try? FileManager.default.removeItem(at: wavURL)
    log(String(format: "done: %@ in %.0f s", opts.out, Date().timeIntervalSince(t0)))
  }

  // Video passthrough + WAV encoded to AAC, into one MP4.
  func mux(video: URL, audio: URL, out: URL) async throws {
    try? FileManager.default.removeItem(at: out)
    let va = AVURLAsset(url: video)
    let aa = AVURLAsset(url: audio)
    let vt = try await va.loadTracks(withMediaType: .video)[0]
    let at = try await aa.loadTracks(withMediaType: .audio)[0]
    let vr = try AVAssetReader(asset: va)
    let ar = try AVAssetReader(asset: aa)
    let vo = AVAssetReaderTrackOutput(track: vt, outputSettings: nil)
    let ao = AVAssetReaderTrackOutput(track: at, outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM])
    vr.add(vo)
    ar.add(ao)
    let w = try AVAssetWriter(outputURL: out, fileType: .mp4)
    let fmt = try await vt.load(.formatDescriptions).first
    let vi = AVAssetWriterInput(mediaType: .video, outputSettings: nil, sourceFormatHint: fmt)
    let ai = AVAssetWriterInput(mediaType: .audio, outputSettings: [
      AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44100, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 192_000,
    ])
    vi.expectsMediaDataInRealTime = false
    ai.expectsMediaDataInRealTime = false
    w.add(vi)
    w.add(ai)
    vr.startReading()
    ar.startReading()
    w.startWriting()
    w.startSession(atSourceTime: .zero)
    await withTaskGroup(of: Void.self) { g in
      for (input, output) in [(vi, vo), (ai, ao)] {
        g.addTask {
          await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            let q = DispatchQueue(label: "mux")
            input.requestMediaDataWhenReady(on: q) {
              while input.isReadyForMoreMediaData {
                if let s = output.copyNextSampleBuffer() { input.append(s) } else {
                  input.markAsFinished()
                  c.resume()
                  return
                }
              }
            }
          }
        }
      }
    }
    await w.finishWriting()
    if w.status != .completed { fatalError("mux failed: \(String(describing: w.error))") }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
Task { @MainActor in
  do {
    let r = Recorder()
    try await r.run()
    exit(0)
  } catch {
    log("error: \(error)")
    exit(1)
  }
}
app.run()
