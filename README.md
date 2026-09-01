# AutoEditPost

Automated video editing for high-volume, authentic-style short-form content.
Drop a raw talking-head clip and the pipeline flips, reframes to vertical,
cleans up the audio, cuts in **your own b-roll** where it fits, and burns
styled captions — all from the command line, no timeline editor.

Built on **FFmpeg** (the actual editing), **Whisper** (transcription), and an
**LLM** (deciding where b-roll cutaways go). There is no CapCut API — this
reproduces the *result*, scriptable and repeatable.

## Why this exists

The current short-form trend rewards raw, authentic footage — talking to
camera, captions on, sparing b-roll from your own library. That style is the
most automatable one there is: film once, and let the pipeline produce the
captioned/reframed/b-rolled cut every time.

## Requirements

- **Node 20+**
- **FFmpeg + ffprobe** on your PATH (`ffmpeg -version` should work)
- For captions/b-roll matching, API keys (see `.env.example`):
  - Transcription: an `OPENAI_API_KEY` (hosted Whisper) **or** the local
    `whisper` CLI (`pip install openai-whisper`)
  - B-roll placement: an `ANTHROPIC_API_KEY`
- Optional, only for face-tracked cropping, covers, and screen cards:
  Python 3 with `pip install pillow opencv-python`

Simple edits (flip, reframe, audio cleanup) need **only FFmpeg** — no keys.

`--enhance-audio` uses RNNoise (`arnndn`) when a model file exists at
`models/std.rnnn` (grab one from an rnnoise-models distribution); without it,
it falls back to FFmpeg's FFT denoise automatically.

## Install

One-shot on a Debian/Ubuntu server (FFmpeg + fonts + deps + build):

```bash
bash scripts/setup.sh
```

Or manually:

```bash
npm install
cp .env.example .env   # fill in keys if using captions / b-roll
npm run build          # or use `npm run dev -- ...` to run TS directly
```

## Usage

```bash
# Dynamic captions (Captions-app style) + vertical reframe
autoeditpost edit raw.mp4 -o out.mp4 --reframe 9:16 --captions hormozi

# Simplest: flip + vertical + default "pop" dynamic captions
autoeditpost edit raw.mp4 -o out.mp4 --flip --reframe 9:16 --captions

# Just clean the audio and mirror it (no API keys needed)
autoeditpost edit raw.mp4 -o out.mp4 --enhance-audio --flip
```

### Dynamic captions (the Captions / Submagic look)

Word-level animated captions — each word times to the audio and pops/highlights
as it's spoken. Powered by Whisper **word-level** timestamps + animated ASS
subtitles. Pick a style:

```bash
autoeditpost styles                       # list templates
autoeditpost edit raw.mp4 -o out.mp4 --captions <style>
```

| Style | Look |
|-------|------|
| `pop` | one bold word at a time, scales in (Captions default) |
| `bounce` | one word at a time with a springy overshoot |
| `hormozi` | 3 uppercase words, spoken word highlighted yellow |
| `karaoke` | full phrase, spoken word fills green |
| `neon` | one word, cyan with a thick glow-style outline |

Prefer plain, non-animated subtitles? Use `--captions-basic` (sentence-level SRT).

**Fonts:** templates request `Montserrat` / `Anton` for the authentic heavy look.
If those aren't installed, libass falls back to a default sans (still renders
fine). Install the fonts, or point at a folder of `.ttf`/`.otf` files with
`CAPTION_FONTS_DIR=/path/to/fonts`.

### B-roll from your own library

1. Put your clips in a folder and index them:

   ```bash
   autoeditpost index --broll ./broll
   ```

   This writes `broll/index.json`. **Edit the descriptions** — that text is
   what the AI matches against the transcript.

2. **Preview placements before rendering** (recommended — you keep taste
   control, the AI does the grunt work):

   ```bash
   autoeditpost plan raw.mp4 --broll ./broll --out broll-plan.json
   # review/edit broll-plan.json, then:
   autoeditpost edit raw.mp4 -o out.mp4 --broll ./broll --broll-plan broll-plan.json --captions
   ```

3. Or let it place b-roll fully automatically in one shot:

   ```bash
   autoeditpost edit raw.mp4 -o out.mp4 --broll ./broll --reframe 9:16 --captions
   ```

## Pipeline order

`enhance-audio → flip → reframe → b-roll → captions`

Transcription runs once against the source (flip/reframe/audio don't change
timing, so timestamps stay valid). Captions are burned last so reframing never
crops them.

## Adding / tuning caption templates

Dynamic templates live in `src/steps/dynamicCaptions.ts` (`TEMPLATES`). Each is
a small config: font, size (fraction of height), primary/highlight/outline
colors, alignment, margin, words-per-chunk, and animation (`pop`/`bounce`/
`none`). Copy an entry, tweak, and it shows up in `autoeditpost styles`.

The plain SRT path (`--captions-basic`) is styled in `src/steps/captions.ts`
(`CaptionStyle`).

## Project layout

```text
AutoEditPost/
  src/
    cli.ts            # command parsing + pipeline orchestration
    lib/
      ffmpeg.ts       # ffmpeg/ffprobe wrappers
      llm.ts          # Anthropic client (b-roll matching)
      types.ts
    steps/
      transcribe.ts   # Whisper (hosted or local)
      captions.ts     # segments -> SRT -> burn-in
      video.ts        # flip, reframe, audio enhance
      broll.ts        # index, LLM match, overlay
  broll/
    index.json        # your b-roll library manifest (clips are gitignored)
```

## LocalCut — desktop studio, MCP server, and web gateway

`localcut/` is a companion app: a local-first talking-head editor with a
Windows Electron UI, a stdio MCP server (so an AI client can drive the
editor), an authenticated upload server, a browser gateway, and Postiz
scheduling/repair tooling.

```bash
cd localcut
npm install
npm test           # 32 self-contained tests, no keys needed
npm run mcp        # stdio MCP server
npm start          # Electron desktop app
npm run dist:win   # Windows installer
```

Postiz publishing needs your own credentials: `POSTIZ_KEY`, plus the
integration id of each channel (`POSTIZ_IG`, `POSTIZ_FACEBOOK`,
`POSTIZ_LINKEDIN`, `POSTIZ_TIKTOK`, `POSTIZ_YOUTUBE`). Optional
`LOCALCUT_YOUTUBE_SITE` appends "Work with me: <site>" to YouTube captions.
See `localcut/README.md` for the editor, upload server, and deploy units.

Note: LocalCut's seven-stage batch-automation drawer drives stage scripts
from a full AutoEditPost production checkout (`AUTOEDITPOST_ROOT`); those
stage scripts are not part of this repo, so the automation drawer is not
runnable from this repo alone. Editing, MCP control, export, review, and
Postiz publishing all work standalone.

## Roadmap

- Auto-tag b-roll with a vision model (skip manual descriptions)
- Emoji injection on keywords in dynamic captions
- Per-keyword color emphasis (highlight nouns/verbs automatically)
- Blurred-background pad option (vs. center crop) for reframing
- RNN denoise (`arnndn`) with a bundled model
- Multiple output variants per run (aspect ratios / caption styles)
- Batch mode over a folder of raw clips

## Status

v0.2 — core pipeline + dynamic captions. Dynamic captions (`pop`, `hormozi`,
`karaoke`, etc.) are **render-verified end-to-end**: word-level timing,
active-word highlighting, wrapping, and outlines all confirmed on real output
frames at 1080×1920. Flip / reframe / audio / b-roll command construction is
complete; b-roll overlay is not yet render-tested against real footage.
