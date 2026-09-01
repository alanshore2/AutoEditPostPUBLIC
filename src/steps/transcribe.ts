import { spawn } from "node:child_process";
import { readFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAsBlob } from "node:fs";
import { ffmpeg } from "../lib/ffmpeg.js";
import type { Transcript, Word } from "../lib/types.js";

/**
 * Transcribe a media file into sentence segments AND word-level timings.
 *
 * Provider is chosen by env:
 *   TRANSCRIBE_PROVIDER=openai (default) | local
 *
 * openai: OpenAI (or compatible) audio transcriptions endpoint with both
 *   segment and word timestamp granularities. Requires OPENAI_API_KEY.
 * local:  the `whisper` CLI (pip install openai-whisper) with
 *   --word_timestamps True. Model via WHISPER_MODEL (default "base").
 */
// Known Whisper mistranscriptions for YOUR speaker, fixed on every transcript so
// captions, cut-takes, and the post caption all get them right. Whole-word, case-
// insensitive; the replacement's casing wins (proper nouns). Add your own, e.g.
//   [/\bcache\b/gi, "cash"],  // Whisper hears "cash" as "cache"
const CORRECTIONS: [RegExp, string][] = [];
function correctTranscript(t: Transcript): Transcript {
  const fix = (s: string) => CORRECTIONS.reduce((acc, [re, rep]) => acc.replace(re, rep), s);
  return {
    segments: t.segments.map((s) => ({ ...s, text: fix(s.text) })),
    words: t.words.map((w) => ({ ...w, word: fix(w.word) })),
  };
}

export async function transcribe(input: string): Promise<Transcript> {
  const provider = process.env.TRANSCRIBE_PROVIDER ?? "openai";
  const t = provider === "local" ? await transcribeLocal(input) : await transcribeOpenAI(input);
  return correctTranscript(t);
}

async function transcribeOpenAI(input: string): Promise<Transcript> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is required for TRANSCRIBE_PROVIDER=openai");
  const base = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const model = process.env.WHISPER_MODEL ?? "whisper-1";

  // OpenAI caps uploads at 25MB; raw video easily exceeds it. Ship audio only.
  const audioDir = await mkdtemp(join(tmpdir(), "aep-audio-"));
  const audioFile = join(audioDir, "audio.mp3");
  await ffmpeg(["-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", audioFile], "ffmpeg (extract audio)");

  const form = new FormData();
  form.append("file", await openAsBlob(audioFile), "audio.mp3");
  form.append("model", model);
  // Optional keyword bias for domain terms Whisper misses. Careful: a heavy
  // prompt can make Whisper hallucinate the keywords into the transcript.
  if (process.env.WHISPER_PROMPT) form.append("prompt", process.env.WHISPER_PROMPT);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  form.append("timestamp_granularities[]", "word");

  let data: any;
  try {
    const res = await fetch(`${base}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    if (!res.ok) {
      throw new Error(`Transcription API failed (${res.status}): ${await res.text()}`);
    }
    data = await res.json();
  } finally {
    await rm(audioDir, { recursive: true, force: true });
  }

  const segments = (data.segments ?? []).map((s: any) => ({
    start: Number(s.start),
    end: Number(s.end),
    text: String(s.text).trim(),
  }));
  const words: Word[] = (data.words ?? []).map((w: any) => ({
    word: String(w.word).trim(),
    start: Number(w.start),
    end: Number(w.end),
  }));

  if (segments.length === 0 && data.text) {
    segments.push({ start: 0, end: 0, text: String(data.text).trim() });
  }
  return { segments, words };
}

async function transcribeLocal(input: string): Promise<Transcript> {
  const model = process.env.WHISPER_MODEL ?? "base";
  const outDir = await mkdtemp(join(tmpdir(), "aep-whisper-"));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "whisper",
      [
        input,
        "--model", model,
        "--word_timestamps", "True",
        "--output_format", "json",
        "--output_dir", outDir,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    child.on("error", (e) =>
      reject(new Error(`local whisper failed to start (pip install openai-whisper?): ${e.message}`)),
    );
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`whisper exited with code ${code}`)),
    );
  });
  const files = await readdir(outDir);
  const jsonFile = files.find((f) => f.endsWith(".json"));
  if (!jsonFile) throw new Error("whisper produced no JSON output");
  const data: any = JSON.parse(await readFile(join(outDir, jsonFile), "utf8"));

  const segments = (data.segments ?? []).map((s: any) => ({
    start: Number(s.start),
    end: Number(s.end),
    text: String(s.text).trim(),
  }));
  // openai-whisper nests words inside each segment when --word_timestamps True.
  const words: Word[] = [];
  for (const s of data.segments ?? []) {
    for (const w of s.words ?? []) {
      words.push({
        word: String(w.word).trim(),
        start: Number(w.start),
        end: Number(w.end),
      });
    }
  }
  return { segments, words };
}
