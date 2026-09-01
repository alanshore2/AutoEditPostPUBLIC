import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildKeepSegments, buildVoiceFilter, createPodcastManager, findOpeningAnnouncement, normalizePodcastOptions, parseSilenceLog, windowsAnnouncementRecognitionArgs } from "../src/podcast.mjs";
import { prepareLocalMediaBinaries } from "../src/pipeline.mjs";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); let stderr = "";
    child.stderr.on("data", (chunk) => stderr += chunk); child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr.slice(-800)}`)));
  });
}

test("podcast options and pause cuts preserve natural short pauses", () => {
  assert.match(createPodcastManager({ dataDir: join(tmpdir(), "localcut-podcast-default-path") }).outputRoot, /Documents[\\/]LocalCut[\\/]Podcasts$/);
  assert.deepEqual(normalizePodcastOptions({ voiceDepth: 999, cleanup: -5, majorSilenceSeconds: .2, retainedPauseSeconds: 9 }), {
    voiceDepth: 100, clarity: 78, cleanup: 0, majorSilenceSeconds: 1, retainedPauseSeconds: 1.2, silenceThresholdDb: -38, preserveVideo: true, removeAnnouncements: true, removeElectricalHum: true, humFrequency: 60,
  });
  assert.deepEqual(findOpeningAnnouncement([{ Text: "Recording in progress", Start: .3, End: 2.2 }]), { phrase: "Recording in progress", start: .3, end: 2.2, openingTrimSeconds: 2.3 });
  assert.equal(findOpeningAnnouncement([{ Text: "We are making progress", Start: .3, End: 2.2 }]), null);
  const recognitionArgs = windowsAnnouncementRecognitionArgs("C:\\Podcast Files\\opening scan.wav");
  assert.equal(recognitionArgs.at(-2), "-Command"); assert.doesNotMatch(recognitionArgs.at(-1), /\$args\[0\]/); assert.match(recognitionArgs.at(-1), /FromBase64String/);
  const silences = parseSilenceLog("silence_start: 1.2\nsilence_end: 3.4 | silence_duration: 2.2", 4.6, 1.6);
  assert.deepEqual(silences, [{ start: 1.2, end: 3.4, duration: 2.2 }]);
  const keep = buildKeepSegments(4.6, silences, .4);
  assert.deepEqual(keep, [{ start: 0, end: 1.4 }, { start: 3.2, end: 4.6 }]);
  assert.match(buildVoiceFilter({ voiceDepth: 70, cleanup: 75 }), /afftdn/);
  assert.match(buildVoiceFilter({ voiceDepth: 70, cleanup: 75 }), /equalizer=f=60:t=q:w=20:g=-30/);
  assert.match(buildVoiceFilter({ voiceDepth: 70, cleanup: 75 }), /equalizer=f=120:t=q:w=25:g=-24/);
  assert.doesNotMatch(buildVoiceFilter({ removeElectricalHum: false }), /equalizer=f=60:t=q:w=20:g=-30/);
  assert.match(buildVoiceFilter({ clarity: 78 }), /equalizer=f=3800:t=q:w=0.75:g=3/);
  assert.match(buildVoiceFilter({ clarity: 78 }), /equalizer=f=7500:t=q:w=0.85:g=1.3/);
  assert.match(buildVoiceFilter({ cleanup: 75 }), /afftdn=nr=11:nf=-35/);
  assert.match(buildVoiceFilter({ voiceDepth: 70, cleanup: 75 }), /loudnorm=I=-16/);
});

test("podcast processor isolates, deepens, removes major silence, and keeps video synchronized", { timeout: 120000 }, async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "localcut-podcast-"));
  try {
    const { ffmpeg } = await prepareLocalMediaBinaries(); const audio = join(sandbox, "source.wav"), video = join(sandbox, "source.mp4");
    await run(ffmpeg, ["-y", "-hide_banner", "-v", "error",
      "-f", "lavfi", "-i", "sine=frequency=120:duration=1.2:sample_rate=48000",
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=2.2",
      "-f", "lavfi", "-i", "sine=frequency=135:duration=1.2:sample_rate=48000",
      "-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1[a]", "-map", "[a]", "-c:a", "pcm_s16le", audio]);
    await run(ffmpeg, ["-y", "-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=c=0x17232b:s=320x180:r=24:d=4.6", "-i", audio, "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", video]);
    const manager = createPodcastManager({ dataDir: join(sandbox, "data"), outputRoot: join(sandbox, "outputs"), detectAnnouncements: false });
    const source = await manager.probe(video); assert.equal(source.hasVideo, true); assert.ok(source.duration > 4.4);
    const progress = []; const result = await manager.process(video, { voiceDepth: 70, cleanup: 70, majorSilenceSeconds: 1.5, retainedPauseSeconds: .4, preserveVideo: true }, (item) => progress.push(item));
    assert.equal(result.analysis.majorSilences.length, 1); assert.ok(result.analysis.removedSeconds > 1.4); assert.ok(result.analysis.outputDuration > 2.5 && result.analysis.outputDuration < 3.2);
    assert.equal(result.analysis.synchronizedVideo, true); await Promise.all(Object.values(result.files).map((path) => access(path)));
    const processed = await manager.probe(result.files.video); assert.equal(processed.hasVideo, true); assert.ok(Math.abs(processed.duration - result.analysis.outputDuration) < .2);
    assert.ok(progress.some((item) => item.stage === "isolate")); assert.ok(progress.some((item) => item.stage === "verify" && item.status === "completed"));
    const audioResult = await manager.process(audio, { voiceDepth: 70, cleanup: 70, majorSilenceSeconds: 1.5, retainedPauseSeconds: .4, preserveVideo: false });
    assert.equal(audioResult.files.video, null); assert.ok(audioResult.analysis.removedSeconds > 1.4); await Promise.all([access(audioResult.files.masterWav), access(audioResult.files.mp3)]);
    const masteredAudio = await manager.probe(audioResult.files.masterWav); assert.equal(masteredAudio.hasVideo, false); assert.ok(masteredAudio.duration > 2.5 && masteredAudio.duration < 3.2);
    assert.equal((await manager.history()).length, 2);
  } finally { await rm(sandbox, { recursive: true, force: true }); }
});
