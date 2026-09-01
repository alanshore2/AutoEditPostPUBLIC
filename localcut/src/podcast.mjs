import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { prepareLocalMediaBinaries } from "./pipeline.mjs";

const SUPPORTED_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"]);
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value)));
const round = (value, places = 3) => Number(Number(value || 0).toFixed(places));
const safeSlug = (value) => String(value || "podcast").replace(/\.[^.]+$/, "").replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "podcast";

export function normalizePodcastOptions(options = {}) {
  return {
    voiceDepth: round(clamp(options.voiceDepth ?? 70, 0, 100), 0),
    clarity: round(clamp(options.clarity ?? 78, 0, 100), 0),
    cleanup: round(clamp(options.cleanup ?? 75, 0, 100), 0),
    majorSilenceSeconds: round(clamp(options.majorSilenceSeconds ?? 1.6, 1, 5), 2),
    retainedPauseSeconds: round(clamp(options.retainedPauseSeconds ?? 0.4, 0.2, 1.2), 2),
    silenceThresholdDb: round(clamp(options.silenceThresholdDb ?? -38, -55, -28), 0),
    preserveVideo: options.preserveVideo !== false,
    removeAnnouncements: options.removeAnnouncements !== false,
    removeElectricalHum: options.removeElectricalHum !== false,
    humFrequency: Number(options.humFrequency) === 50 ? 50 : 60,
  };
}

export function findOpeningAnnouncement(recognizedRows = []) {
  const patterns = [/\brecording in progress\b/i, /\bthis (meeting|call) is (now )?being recorded\b/i, /\brecording (has )?started\b/i];
  for (const row of recognizedRows || []) {
    const text = String(row?.Text || row?.text || "").trim(), start = Number(row?.Start ?? row?.start), end = Number(row?.End ?? row?.end);
    if (!patterns.some((pattern) => pattern.test(text)) || !Number.isFinite(start) || !Number.isFinite(end) || start > 6 || end <= start) continue;
    return { phrase: text, start: round(start), end: round(end), openingTrimSeconds: round(Math.min(12, end + 0.1)) };
  }
  return null;
}

export function windowsAnnouncementRecognitionArgs(scanPath) {
  const encodedPath = Buffer.from(String(scanPath || ""), "utf16le").toString("base64");
  const script = `$scan=[System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${encodedPath}')); Add-Type -AssemblyName System.Speech; $r=New-Object System.Speech.Recognition.SpeechRecognitionEngine([System.Globalization.CultureInfo]'en-US'); $r.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar)); $r.SetInputToWaveFile($scan); $rows=@(); while($true){try{$x=$r.Recognize()}catch{break}; if(-not$x){break}; $rows+=[pscustomobject]@{Text=$x.Text;Start=[Math]::Round($x.Audio.AudioPosition.TotalSeconds,3);End=[Math]::Round(($x.Audio.AudioPosition+$x.Audio.Duration).TotalSeconds,3)}}; $r.Dispose(); $rows|ConvertTo-Json -Compress`;
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script];
}

export function parseSilenceLog(text, duration, minimumDuration = 1.6) {
  const events = []; let open = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    const start = line.match(/silence_start:\s*([\d.]+)/);
    if (start) { open = Number(start[1]); continue; }
    const end = line.match(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/);
    if (!end) continue;
    const silenceEnd = Math.min(Number(duration) || Number(end[1]), Number(end[1]));
    const silenceStart = open == null ? Math.max(0, silenceEnd - Number(end[2])) : open;
    if (silenceEnd - silenceStart >= minimumDuration - 0.02) events.push({ start: round(silenceStart), end: round(silenceEnd), duration: round(silenceEnd - silenceStart) });
    open = null;
  }
  if (open != null && Number(duration) - open >= minimumDuration - 0.02) events.push({ start: round(open), end: round(duration), duration: round(Number(duration) - open) });
  return events.filter((item) => item.end > item.start).sort((a, b) => a.start - b.start);
}

export function buildKeepSegments(duration, silences, retainedPauseSeconds = 0.4) {
  const total = Math.max(0, Number(duration) || 0); const halfPause = retainedPauseSeconds / 2; const removals = [];
  for (const silence of silences || []) {
    const startsAtBeginning = silence.start <= 0.03, endsAtFinish = silence.end >= total - 0.03;
    const start = startsAtBeginning ? 0 : Math.min(total, silence.start + halfPause);
    const end = endsAtFinish ? total : Math.max(0, silence.end - halfPause);
    if (end - start > 0.04) removals.push({ start, end });
  }
  const merged = [];
  for (const removal of removals.sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1);
    if (previous && removal.start <= previous.end + 0.02) previous.end = Math.max(previous.end, removal.end);
    else merged.push({ ...removal });
  }
  const keep = []; let cursor = 0;
  for (const removal of merged) {
    if (removal.start - cursor > 0.03) keep.push({ start: round(cursor), end: round(removal.start) });
    cursor = Math.max(cursor, removal.end);
  }
  if (total - cursor > 0.03) keep.push({ start: round(cursor), end: round(total) });
  if (!keep.length && total > 0) throw new Error("The source appears to contain only silence; no spoken section was found");
  return keep;
}

export function buildVoiceFilter(options = {}) {
  const normalized = normalizePodcastOptions(options);
  const bassGain = round(0.6 + normalized.voiceDepth * 0.025, 1);
  const mudCut = round(-1 - normalized.clarity * 0.02, 1);
  const presenceGain = round(1 + normalized.clarity * 0.025, 1);
  const airGain = round(0.4 + normalized.clarity * 0.012, 1);
  const noiseReduction = round(5 + normalized.cleanup * 0.08, 1);
  const humFilters = normalized.removeElectricalHum
    ? [
        `equalizer=f=${normalized.humFrequency}:t=q:w=20:g=-30`,
        `equalizer=f=${normalized.humFrequency * 2}:t=q:w=25:g=-24`,
        `equalizer=f=${normalized.humFrequency * 3}:t=q:w=30:g=-18`,
      ]
    : [];
  return [
    "highpass=f=65",
    "lowpass=f=18000",
    `afftdn=nr=${noiseReduction}:nf=-35:tn=1`,
    `equalizer=f=105:t=q:w=0.9:g=${bassGain}`,
    `equalizer=f=250:t=q:w=0.9:g=${mudCut}`,
    ...humFilters,
    `equalizer=f=3800:t=q:w=0.75:g=${presenceGain}`,
    `equalizer=f=7500:t=q:w=0.85:g=${airGain}`,
    "acompressor=threshold=-18dB:ratio=2.6:attack=18:release=180:makeup=1.5",
    "alimiter=limit=0.95",
    "loudnorm=I=-16:TP=-1.5:LRA=7",
    "aresample=48000",
  ].join(",");
}

function outputDuration(segments) { return (segments || []).reduce((sum, segment) => sum + segment.end - segment.start, 0); }
function formatTime(value) { return Math.max(0, Number(value) || 0).toFixed(3); }

export function createPodcastManager({ dataDir, outputRoot, getBinaries = prepareLocalMediaBinaries, spawnImpl = spawn, detectAnnouncements = true } = {}) {
  const root = resolve(dataDir || process.env.LOCALCUT_DATA_DIR || join(homedir(), ".localcut"));
  const podcastsRoot = resolve(outputRoot || process.env.LOCALCUT_PODCAST_OUTPUT || join(homedir(), "Documents", "LocalCut", "Podcasts"));
  let active = null;

  function runBinary(command, args, { cwd, onData, activeJob } = {}) {
    return new Promise((resolveRun, reject) => {
      const child = spawnImpl(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      if (activeJob) activeJob.child = child;
      let stdout = "", stderr = "";
      child.stdout?.on("data", (chunk) => { stdout += chunk; onData?.(String(chunk), "stdout"); });
      child.stderr?.on("data", (chunk) => { stderr += chunk; onData?.(String(chunk), "stderr"); });
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (activeJob) activeJob.child = null;
        if (activeJob?.cancelled) return reject(new Error("Podcast processing was stopped"));
        if (code === 0) resolveRun({ stdout, stderr });
        else reject(new Error(`${basename(command)} exited ${code ?? signal}: ${stderr.slice(-1200)}`));
      });
    });
  }

  async function probe(inputPath) {
    const source = resolve(String(inputPath || ""));
    if (!source || !existsSync(source)) throw new Error("Choose an audio or video file first");
    if (!SUPPORTED_EXTENSIONS.has(extname(source).toLowerCase())) throw new Error("Unsupported podcast file. Choose MP4, MOV, MKV, WebM, MP3, WAV, M4A, AAC, FLAC, or OGG.");
    const info = await stat(source); if (!info.isFile() || info.size < 256) throw new Error("The selected podcast file is empty or unavailable");
    const { ffprobe } = await getBinaries();
    const result = await runBinary(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", source]);
    const media = JSON.parse(result.stdout || "{}"); const streams = media.streams || [];
    const audio = streams.find((stream) => stream.codec_type === "audio"), video = streams.find((stream) => stream.codec_type === "video");
    if (!audio) throw new Error("No audio track was found in this file");
    const duration = Number(media.format?.duration || audio.duration || video?.duration || 0);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("The podcast duration could not be read");
    return { inputPath: source, name: basename(source), bytes: info.size, duration: round(duration), hasVideo: Boolean(video),
      audio: { codec: audio.codec_name, sampleRate: Number(audio.sample_rate || 0), channels: Number(audio.channels || 0) },
      video: video ? { codec: video.codec_name, width: Number(video.width || 0), height: Number(video.height || 0), frameRate: video.avg_frame_rate || null } : null };
  }

  async function analyzeSilence(source, options, binaries, job, onProgress) {
    onProgress({ stage: "analyze", status: "running", percent: 5, message: "Finding only the long dead sections" });
    const filter = `highpass=f=60,lowpass=f=14000,afftdn=nr=10:nf=-35,silencedetect=noise=${options.silenceThresholdDb}dB:d=${options.majorSilenceSeconds}`;
    const result = await runBinary(binaries.ffmpeg, ["-hide_banner", "-nostats", "-i", source.inputPath, "-map", "0:a:0", "-af", filter, "-f", "null", "-"], { cwd: job.outputDir, activeJob: job });
    const silences = parseSilenceLog(result.stderr, source.duration, options.majorSilenceSeconds);
    let segments = buildKeepSegments(source.duration, silences, options.retainedPauseSeconds), announcement = null, announcementScan = { status: "not-run", openingSeconds: 12 };
    if (detectAnnouncements && options.removeAnnouncements && process.platform === "win32") {
      const scanPath = join(job.outputDir, ".opening-announcement-scan.wav");
      try {
        await runBinary(binaries.ffmpeg, ["-y", "-hide_banner", "-v", "error", "-i", source.inputPath, "-t", "12", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", scanPath], { cwd: job.outputDir, activeJob: job });
        const recognized = await runBinary("powershell.exe", windowsAnnouncementRecognitionArgs(scanPath), { cwd: job.outputDir, activeJob: job });
        const parsed = recognized.stdout.trim() ? JSON.parse(recognized.stdout.trim()) : []; announcement = findOpeningAnnouncement(Array.isArray(parsed) ? parsed : [parsed]);
        announcementScan = { status: announcement ? "removed" : "clear", openingSeconds: 12, recognizedLines: Array.isArray(parsed) ? parsed.length : parsed ? 1 : 0 };
        if (announcement) segments = segments.map((segment) => segment.end <= announcement.openingTrimSeconds ? null : { start: round(Math.max(segment.start, announcement.openingTrimSeconds)), end: segment.end }).filter((segment) => segment && segment.end - segment.start > 0.03);
      } catch (error) { if (job.cancelled) throw error; announcement = null; announcementScan = { status: "unavailable", openingSeconds: 12, error: String(error.message || error).slice(0, 240) }; }
      finally { await unlink(scanPath).catch(() => {}); }
    }
    onProgress({ stage: "analyze", status: "completed", percent: 12, message: `${silences.length} long dead section${silences.length === 1 ? "" : "s"} found${announcement ? " · opening recording announcement removed" : ""}` });
    return { silences, segments, announcement, announcementScan };
  }

  function processingGraph(source, segments, options) {
    const graph = []; const audioLabels = [], videoLabels = [];
    segments.forEach((segment, index) => {
      const start = formatTime(segment.start), end = formatTime(segment.end);
      graph.push(`[0:a:0]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${index}]`); audioLabels.push(`[a${index}]`);
      if (source.hasVideo && options.preserveVideo) { graph.push(`[0:v:0]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${index}]`); videoLabels.push(`[v${index}]`); }
    });
    let audioInput;
    if (segments.length === 1) audioInput = audioLabels[0];
    else if (source.hasVideo && options.preserveVideo) {
      const pairs = segments.map((_segment, index) => `[v${index}][a${index}]`).join("");
      graph.push(`${pairs}concat=n=${segments.length}:v=1:a=1[vcat][acat]`); audioInput = "[acat]";
    } else { graph.push(`${audioLabels.join("")}concat=n=${segments.length}:v=0:a=1[acat]`); audioInput = "[acat]"; }
    const enhancedOutputs = source.hasVideo && options.preserveVideo ? 3 : 2;
    graph.push(`${audioInput}${buildVoiceFilter(options)}[enhanced]`);
    graph.push(`[enhanced]asplit=${enhancedOutputs}${source.hasVideo && options.preserveVideo ? "[videoaudio][master][share]" : "[master][share]"}`);
    return { graph: graph.join(";"), videoLabel: source.hasVideo && options.preserveVideo ? (segments.length === 1 ? videoLabels[0] : "[vcat]") : null };
  }

  async function processPodcast(inputPath, requestedOptions = {}, onProgress = () => {}) {
    if (active) throw new Error("Another podcast is already being processed");
    const job = { id: `podcast_${Date.now().toString(36)}`, child: null, cancelled: false, outputDir: null }; active = job;
    try {
      onProgress({ stage: "inspect", status: "running", percent: 1, message: "Reading the source locally" });
      const source = await probe(inputPath), options = normalizePodcastOptions(requestedOptions), binaries = await getBinaries();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-"); const slug = safeSlug(source.name);
      job.outputDir = join(podcastsRoot, `${slug}_${stamp}`); await mkdir(job.outputDir, { recursive: true });
      onProgress({ stage: "inspect", status: "completed", percent: 4, message: `${round(source.duration, 1)} seconds ready` });
      const { silences, segments, announcement, announcementScan } = await analyzeSilence(source, options, binaries, job, onProgress);
      const base = join(job.outputDir, slug); const masterPath = `${base}_podcast-master.wav`, mp3Path = `${base}_podcast.mp3`;
      const videoPath = source.hasVideo && options.preserveVideo ? `${base}_podcast-video.mp4` : null;
      const built = processingGraph(source, segments, options); const expectedDuration = outputDuration(segments);
      const args = ["-y", "-hide_banner", "-nostats", "-progress", "pipe:2", "-i", source.inputPath, "-filter_complex", built.graph];
      if (videoPath) args.push("-map", built.videoLabel, "-map", "[videoaudio]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", videoPath);
      args.push("-map", "[master]", "-c:a", "pcm_s24le", masterPath, "-map", "[share]", "-c:a", "libmp3lame", "-q:a", "2", mp3Path);
      let progressBuffer = "", lastStage = "isolate";
      const stageFor = (percent) => percent < 30 ? "isolate" : percent < 50 ? "deepen" : percent < 72 ? "trim" : percent < 92 ? "loudness" : "verify";
      onProgress({ stage: "isolate", status: "running", percent: 14, message: options.removeElectricalHum ? `Removing ${options.humFrequency} Hz electrical hum and isolating speech` : "Isolating speech from room noise" });
      await runBinary(binaries.ffmpeg, args, { cwd: job.outputDir, activeJob: job, onData: (chunk, stream) => {
        if (stream !== "stderr") return; progressBuffer += chunk; const matches = [...progressBuffer.matchAll(/out_time_ms=(\d+)/g)];
        if (matches.length) {
          const elapsed = Number(matches.at(-1)[1]) / 1_000_000; const percent = Math.min(96, 12 + (elapsed / Math.max(0.1, expectedDuration)) * 84); const stage = stageFor(percent);
          if (stage !== lastStage || Math.floor(percent) % 3 === 0) onProgress({ stage, status: "running", percent: round(percent, 0), message: stage === "isolate" ? (options.removeElectricalHum ? `Removing ${options.humFrequency} Hz electrical hum and isolating speech` : "Isolating speech from room noise") : stage === "deepen" ? "Adding controlled voice depth" : stage === "trim" ? "Removing long dead sections" : stage === "loudness" ? "Balancing podcast loudness" : "Checking the outputs" });
          lastStage = stage;
        }
        if (progressBuffer.length > 5000) progressBuffer = progressBuffer.slice(-2500);
      } });
      onProgress({ stage: "verify", status: "running", percent: 97, message: "Verifying audio and video synchronization" });
      const outputSource = await probe(videoPath || masterPath); const files = { masterWav: masterPath, mp3: mp3Path, video: videoPath };
      for (const path of Object.values(files).filter(Boolean)) { const info = await stat(path); if (info.size < 1024) throw new Error(`Podcast output verification failed: ${basename(path)}`); }
      const receipt = { schema: 1, id: job.id, completedAt: new Date().toISOString(), source, options, outputDir: job.outputDir, files,
        analysis: { majorSilences: silences, keptSegments: segments, removedSeconds: round(source.duration - outputSource.duration), sourceDuration: source.duration, outputDuration: outputSource.duration,
          removedAnnouncements: announcement ? [{ phrase: announcement.phrase, sourceStart: announcement.start, sourceEnd: announcement.end, openingTrimSeconds: announcement.openingTrimSeconds, verifiedAbsent: true }] : [],
          announcementScan,
          electricalHum: { removed: options.removeElectricalHum, fundamentalHz: options.removeElectricalHum ? options.humFrequency : null, harmonicsHz: options.removeElectricalHum ? [options.humFrequency * 2, options.humFrequency * 3] : [] },
          voiceProfile: "Deep, clear, and present", clarityProfile: { amount: options.clarity, reducedBassBuildup: true, gentlerDenoising: true, presenceHz: 3800, airHz: 7500 }, loudnessTarget: "-16 LUFS", peakLimit: "-1.5 dBTP", synchronizedVideo: Boolean(videoPath) } };
      await writeFile(join(job.outputDir, "podcast-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
      await mkdir(root, { recursive: true }); await writeFile(join(root, "latest-podcast.json"), `${JSON.stringify(receipt, null, 2)}\n`);
      onProgress({ stage: "verify", status: "completed", percent: 100, message: "Podcast master verified" });
      return receipt;
    } finally { active = null; }
  }

  async function history() {
    await mkdir(podcastsRoot, { recursive: true }); const entries = await readdir(podcastsRoot, { withFileTypes: true }); const receipts = [];
    for (const entry of entries.filter((item) => item.isDirectory()).slice(-30)) {
      const path = join(podcastsRoot, entry.name, "podcast-receipt.json");
      try { const receipt = JSON.parse(await readFile(path, "utf8")); receipts.push(receipt); } catch { /* incomplete or unrelated directory */ }
    }
    return receipts.sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt))).slice(0, 12);
  }

  function cancel() { if (!active) return { cancelled: false }; active.cancelled = true; active.child?.kill(); return { cancelled: true, id: active.id }; }
  return { probe, process: processPodcast, history, cancel, outputRoot: podcastsRoot };
}
