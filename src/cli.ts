#!/usr/bin/env node
import { Command } from "commander";
import { mkdtemp, rm, writeFile, readFile, readdir, rename, mkdir, copyFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { probe } from "./lib/ffmpeg.js";
import { transcribe } from "./steps/transcribe.js";
import { burnCaptions } from "./steps/captions.js";
import { burnDynamicCaptions, listTemplates } from "./steps/dynamicCaptions.js";
import { flip as flipStep, reframe as reframeStep, enhanceAudio, detectChinTrack, detectCaptionZone, gradeVideo } from "./steps/video.js";
import { renderCard, applyCard, resolveCardTiming } from "./steps/cards.js";
import type { CardSpec, CardTiming } from "./steps/cards.js";
import { detectFaceTrack, trackCrop, verifyFraming } from "./steps/trackCrop.js";
import type { ChinSample } from "./steps/video.js";
import { indexBroll, loadLibrary, matchBroll, applyBroll } from "./steps/broll.js";
import { detectSilences, planTakeCuts, mergeCuts, applyCuts, type CutRange } from "./steps/cuts.js";
import { splitTakes } from "./steps/takes.js";
import { writePostCaption, writeMirrorCaption, makeCover, prependCover } from "./steps/publish.js";
import type { BrollPlacement, Transcript } from "./lib/types.js";

const program = new Command();
program
  .name("autoeditpost")
  .description("AutoEditPost — auto-edit talking-head clips ready to post (FFmpeg + Whisper + LLM)")
  .version("0.2.0");

program
  .command("index")
  .description("Build/refresh the b-roll library index (index.json) for a folder")
  .requiredOption("--broll <dir>", "b-roll directory")
  .action(async (opts) => {
    const lib = await indexBroll(opts.broll);
    console.log(`Indexed ${lib.clips.length} clip(s) in ${opts.broll}/index.json`);
    console.log("Edit the descriptions there so the AI can place clips well.");
  });

program
  .command("plan")
  .description("Transcribe + propose b-roll placements without rendering (for approval)")
  .argument("<input>", "input video")
  .requiredOption("--broll <dir>", "b-roll directory (must have index.json)")
  .option("--out <file>", "write the plan JSON here", "broll-plan.json")
  .action(async (input, opts) => {
    const { segments } = await transcribe(input);
    const lib = await loadLibrary(opts.broll);
    const placements = await matchBroll(segments, lib);
    await writeFile(opts.out, JSON.stringify(placements, null, 2) + "\n");
    printPlan(placements);
    console.log(`\nPlan written to ${opts.out}. Review/edit it, then:`);
    console.log(`  autoeditpost edit ${input} --broll ${opts.broll} --broll-plan ${opts.out} ...`);
  });

program
  .command("takes")
  .description("Split a raw multi-take recording into per-take clips + takes.txt (good/bad flagged)")
  .argument("<input>", "raw recording (multiple takes of the same lines)")
  .option("--out <dir>", "output folder", "takes")
  .option("--min-gap <sec>", "silence gap that separates takes", "1.5")
  .action(async (input, opts) => {
    if (!existsSync(input)) throw new Error(`Input not found: ${input}`);
    const takes = await splitTakes(input, opts.out, Number(opts.minGap));
    const good = takes.filter((t) => !t.bad).length;
    console.log(`\nDone: ${takes.length} takes -> ${opts.out}/ (${good} good, ${takes.length - good} bad)`);
  });

program
  .command("batch")
  .description("Process every video in Raw/: split long multi-take raws, edit each good take with the standard recipe, move sources to Done/")
  .option("--raw <dir>", "incoming raw folder", "Raw")
  .option("--done <dir>", "processed-source folder", "Done")
  .option("--outdir <dir>", "edited output folder", "out")
  .option("--limit <n>", "max source videos this run")
  .option("--style <style>", "caption style", "hormozi")
  .option("--broll <dir>", "b-roll library for auto cutaways (needs <dir>/index.json)", "broll")
  .option("--no-broll", "skip b-roll cutaways")
  .option("--multi-take-min <sec>", "duration above which a raw is split into takes first", "120")
  .action(async (opts) => {
    const files = (await readdir(opts.raw)).filter((f: string) => /\.(mp4|mov|m4v)$/i.test(f)).sort();
    if (files.length === 0) {
      console.log(`Nothing to do: no videos in ${opts.raw}/`);
      return;
    }
    const limit = opts.limit ? Number(opts.limit) : Infinity;
    await mkdir(opts.done, { recursive: true });
    await mkdir(opts.outdir, { recursive: true });
    let processed = 0;
    for (const f of files) {
      if (processed >= limit) break;
      processed++;
      const src = join(opts.raw, f);
      const meta = await probe(src);
      const base = f.replace(/\.[^.]+$/, "");
      let clips: string[];
      if (meta.durationSec > Number(opts.multiTakeMin)) {
        console.log(`\n=== ${f} (${meta.durationSec.toFixed(0)}s): multi-take raw -> splitting takes`);
        const takes = await splitTakes(src, join("takes", base));
        clips = takes.filter((t) => !t.bad).map((t) => join("takes", base, t.file!));
        console.log(`=== ${clips.length} good take(s) to edit`);
      } else {
        clips = [src];
      }
      for (const clip of clips) {
        // Each video gets its own folder: out/<name>/<name>_reel.mp4 + mirror
        // (the trial-reel copy) + covers + caption, all together.
        const clipBase = basename(clip).replace(/\.[^.]+$/, "");
        const videoDir = join(opts.outdir, clipBase);
        await mkdir(videoDir, { recursive: true });
        const outFile = join(videoDir, `${clipBase}_reel.mp4`);
        if (existsSync(outFile)) {
          console.log(`skip ${outFile} (already edited)`);
          continue;
        }
        console.log(`\n--- editing ${clip} -> ${outFile}`);
        // B-roll only when the library actually has an index (and not --no-broll).
        const brollDir =
          opts.broll && existsSync(join(opts.broll, "index.json")) ? opts.broll : undefined;
        await runEdit(clip, {
          output: outFile,
          cutTakes: true,
          trimSilence: true,
          enhanceAudio: true,
          reframe: "9:16",
          cropHead: true,
          grade: "neutral_punch",
          broll: brollDir,
          captions: opts.style,
          mirrorClone: true,
          duoTrial: true,
          postCaption: true,
          cover: true,
        });
      }
      // rclone-backed mounts sometimes EIO on rename; copy+delete is sturdier.
      const dest = join(opts.done, f);
      try {
        await rename(src, dest);
      } catch {
        await copyFile(src, dest);
        await unlink(src);
      }
      console.log(`moved ${f} -> ${opts.done}/`);
    }
    console.log(`\nBatch done: ${processed} source video(s) processed.`);
  });

program
  .command("styles")
  .description("List available dynamic caption templates")
  .action(() => {
    console.log("Dynamic caption styles:");
    for (const name of listTemplates()) console.log(`  ${name}`);
    console.log("\nUse: autoeditpost edit in.mp4 -o out.mp4 --captions <style>");
  });

program
  .command("edit")
  .description("Run the editing pipeline on a video")
  .argument("<input>", "input video")
  .requiredOption("-o, --output <file>", "output video")
  .option("--cut-takes", "LLM finds repeated takes/flubs in the transcript and cuts them")
  .option(
    "--trim-silence [seconds]",
    "cut silences longer than this many seconds (default 0.6)",
  )
  .option("--enhance-audio", "denoise + loudness-normalize speech")
  .option("--flip [dir]", "mirror video: h (default) or v")
  .option("--reframe [aspect]", "crop to aspect, e.g. 9:16")
  .option(
    "--crop-head [margin]",
    "zoom-crop so the head sits near the top (vision-detected; margin = headroom fraction, default 0.08)",
  )
  .option(
    "--grade [preset]",
    "color grade: subtle, neutral_punch (default), warm_cinematic",
  )
  .option(
    "--captions [style]",
    `dynamic word-level captions; style one of: ${listTemplates().join(", ")} (default pop)`,
  )
  .option("--captions-basic", "plain sentence-level SRT captions (no animation)")
  .option(
    "--no-chin-track",
    "don't track the chin to keep dynamic captions below the face (tracking is on by default when OPENAI_API_KEY is set)",
  )
  .option(
    "--caption-zone <mode>",
    "auto (default) | top | bottom — auto places screen-recording / show-n-tell captions at TOP (off what you point at) and talking-head captions at bottom; signal-only, no vision model",
    "auto",
  )
  .option("--mirror-clone", "also render a horizontally mirrored clone (_mirror.mp4) — flipped before captions so text stays readable")
  .option("--card <json>", "screen-card spec JSON (CardSpec, optionally with pre-rendered a/b png paths) — composited over the face before captions")
  .option("--caption-file <path>", "use this pre-written post caption instead of generating one (campaign copy pass)")
  .option("--cover-json <path>", "use this pre-written cover text {kicker,accent,headline} instead of generating one")
  .option("--crop-zoom <factor>", "widen the tracked crop window: 1.0 tight face-fit (default), 1.25 = 25% more background")
  .option("--duo-trial", "also render a non-mirrored variant with duo captions (_trial.mp4) — the trial-reel copy")
  .option("--post-caption", "write an authentic IG post caption from the transcript (<output>.caption.txt)")
  .option("--cover", "generate a styled cover image from a clean frame + transcript (<output>.cover.png)")
  .option("--broll <dir>", "b-roll directory (auto-plans unless --broll-plan given)")
  .option("--broll-plan <file>", "use a pre-approved placement JSON from `autoeditpost plan`")
  .action(runEdit);

async function runEdit(input: string, opts: any) {
  if (!existsSync(input)) throw new Error(`Input not found: ${input}`);
  const work = await mkdtemp(join(tmpdir(), "autoeditpost-"));
  let cur = input;
  let step = 0;
  const next = (ext = "mp4") => join(work, `s${++step}.${ext}`);

  try {
    // Transcribe once up front if any step needs it (timing is unaffected by
    // flip/reframe/enhance, so segments/words stay valid — EXCEPT cuts, which
    // change timing; after cutting we re-transcribe the edited video below).
    let transcript: Transcript | null = null;
    const needsTranscriptLater =
      opts.captions || opts.captionsBasic || (opts.broll && !opts.brollPlan);
    if (needsTranscriptLater || opts.cutTakes) {
      console.log("Transcribing...");
      transcript = await transcribe(input);
    }

    // Cuts run first, on the untouched source: silence detection wants the
    // original noise floor, and every later step works on the tightened clip.
    if (opts.cutTakes || opts.trimSilence) {
      const cuts: CutRange[] = [];
      if (opts.cutTakes) {
        console.log("Planning take cuts (LLM)...");
        cuts.push(...(await planTakeCuts(transcript!.segments)));
      }
      if (opts.trimSilence) {
        const gap = opts.trimSilence === true ? 0.6 : Number(opts.trimSilence);
        console.log(`Detecting silences (>${gap}s)...`);
        cuts.push(...(await detectSilences(cur, gap)));
      }
      const { durationSec } = await probe(cur);
      const merged = mergeCuts(cuts, durationSec);
      if (merged.length > 0) {
        const removed = merged.reduce((s, c) => s + (c.end - c.start), 0);
        console.log(`Applying ${merged.length} cut(s), removing ${removed.toFixed(1)}s:`);
        for (const c of merged)
          console.log(`  ${c.start.toFixed(1)}-${c.end.toFixed(1)}s  ${c.reason ?? ""}`);
        const o = next();
        await applyCuts(cur, merged, o);
        cur = o;
        if (needsTranscriptLater) {
          console.log("Re-transcribing edited video (caption timing)...");
          transcript = await transcribe(cur);
        }
      } else {
        console.log("No cuts needed.");
      }
    }

    if (opts.enhanceAudio) {
      console.log("Enhancing audio...");
      const o = next();
      await enhanceAudio(cur, o);
      cur = o;
    }

    if (opts.flip) {
      const dir = opts.flip === true ? "h" : opts.flip;
      console.log(`Flipping (${dir})...`);
      const o = next();
      await flipStep(cur, o, dir === "v" ? "v" : "h");
      cur = o;
    }

    if (opts.reframe) {
      const aspect = opts.reframe === true ? "9:16" : opts.reframe;
      console.log(`Reframing to ${aspect}...`);
      const o = next();
      await reframeStep(cur, o, aspect);
      cur = o;
    }

    let croppedChinTrack: ChinSample[] | undefined;
    if (opts.cropHead) {
      const margin = opts.cropHead === true ? 0.08 : Number(opts.cropHead);
      console.log("Tracking face for dynamic crop...");
      const faceTrack = await detectFaceTrack(cur);
      if (faceTrack.length === 0) {
        console.log("  no face detected; skipping crop");
      } else {
        const o = next();
        const zoomOut = opts.cropZoom ? Number(opts.cropZoom) : 1.0;
        const { chinTrack } = await trackCrop(cur, o, faceTrack, margin, 0.22, 0.04, zoomOut);
        croppedChinTrack = chinTrack;
        cur = o;
      }
    }

    if (opts.broll) {
      let placements: BrollPlacement[];
      if (opts.brollPlan) {
        placements = JSON.parse(await readFile(opts.brollPlan, "utf8"));
      } else {
        console.log("Planning b-roll...");
        const lib = await loadLibrary(opts.broll);
        placements = await matchBroll(transcript!.segments, lib);
        printPlan(placements);
      }
      if (placements.length > 0) {
        console.log(`Applying ${placements.length} b-roll cutaway(s)...`);
        const o = next();
        await applyBroll(cur, opts.broll, placements, o);
        cur = o;
      } else {
        console.log("No b-roll placements chosen; skipping.");
      }
    }

    if (opts.grade) {
      const preset = opts.grade === true ? "neutral_punch" : opts.grade;
      console.log(`Color grading (${preset})...`);
      const o = next();
      await gradeVideo(cur, o, preset);
      cur = o;
    }

    // Screen card: composited over the face BEFORE captions. The mirror
    // variant needs the card applied AFTER its flip (the card has text), so
    // keep the card-less base and the resolved timing around.
    let preCardBase: string | null = null;
    let cardTiming: CardTiming | null = null;
    let cardPngs: { a: string; b: string } | null = null;
    let cardCta: string | null = null;
    if (opts.card) {
      const card: CardSpec & { a?: string; b?: string } = JSON.parse(
        await readFile(opts.card, "utf8"),
      );
      cardCta = card.cta || null;
      cardPngs =
        card.a && card.b
          ? { a: card.a, b: card.b }
          : await renderCard(card, join(work, "card"));
      const { durationSec } = await probe(cur);
      const timing = resolveCardTiming(transcript!.words, card.hl_spoken, durationSec);
      console.log(
        `Compositing card: in ${timing.tIn.toFixed(1)}s, highlight ${timing.tHl.toFixed(1)}s` +
          `${timing.beatFound ? "" : " (beat NOT found in transcript — using 40% fallback)"}, out ${timing.tOut.toFixed(1)}s`,
      );
      cardTiming = timing;
      preCardBase = cur;
      const o = next();
      await applyCard(cur, o, cardPngs.a, cardPngs.b, timing);
      cur = o;
    }

    let mirrorCur: string | null = null;
    let duoCur: string | null = null;
    let cleanForCover: string | null = null;
    if (opts.captions) {
      let style = typeof opts.captions === "string" ? opts.captions : "pop";
      // Auto-place captions by clip type: screen-recording / show-n-tell -> TOP,
      // talking-head -> bottom. Signal-only (no vision). Only the hormozi house
      // style has a top variant; other styles are left exactly as chosen.
      const TOP_VARIANT: Record<string, string> = { hormozi: "hormozi_top" };
      if (TOP_VARIANT[style]) {
        let zone: string = opts.captionZone ?? "auto";
        if (zone === "auto") zone = await detectCaptionZone(cur);
        if (zone === "top") {
          console.log(`  caption zone: TOP (screen / show-n-tell) -> ${TOP_VARIANT[style]}`);
          style = TOP_VARIANT[style];
        } else {
          console.log(`  caption zone: BOTTOM (talking-head)`);
        }
      }
      let chinTrack = croppedChinTrack;
      // Top templates anchor to the top edge; a chin track would drag them back
      // down under the (nonexistent) face, so never pass one for a _top style.
      if (String(style).endsWith("_top")) chinTrack = undefined;
      if (!String(style).endsWith("_top") && !chinTrack && opts.chinTrack !== false && process.env.OPENAI_API_KEY) {
        console.log("Tracking chin position (captions stay below the face)...");
        chinTrack = await detectChinTrack(cur);
        console.log(`  chin track: ${chinTrack.length} samples`);
      }
      console.log(`Burning dynamic captions (${style})...`);
      const dims = await probe(cur);
      const preCaption = cur;
      cleanForCover = preCaption;
      let o = next();
      await burnDynamicCaptions(preCaption, o, transcript!.words, style, dims.width, dims.height, transcript!.segments, chinTrack);
      cur = o;

      if (opts.mirrorClone) {
        // Mirror the PRE-caption picture, then burn captions fresh — burning
        // first and flipping after would render the text backwards. Same for
        // the card: flip the card-less base, THEN composite the card.
        console.log("Rendering mirrored clone...");
        const flipped = next();
        await flipStep(preCardBase ?? preCaption, flipped, "h");
        let mirrorBase = flipped;
        if (cardPngs && cardTiming) {
          const carded = next();
          await applyCard(flipped, carded, cardPngs.a, cardPngs.b, cardTiming);
          mirrorBase = carded;
        }
        const m = next();
        await burnDynamicCaptions(mirrorBase, m, transcript!.words, style, dims.width, dims.height, transcript!.segments, chinTrack);
        mirrorCur = m;
      }

      if (opts.duoTrial) {
        // Trial-reel variant: same picture, duo captions — visually distinct
        // from the follower reel without mirroring.
        console.log("Rendering duo trial variant...");
        const d = next();
        await burnDynamicCaptions(preCaption, d, transcript!.words, "duo", dims.width, dims.height, transcript!.segments, chinTrack);
        duoCur = d;
      }

      // QA (geometric): caption placement is derived from the measured face
      // track, so verify the track itself had no blind spots — a detection
      // gap means the camera and captions flew blind there.
      if (chinTrack && chinTrack.length > 1) {
        let worstGap = 0;
        for (let i = 1; i < chinTrack.length; i++)
          worstGap = Math.max(worstGap, chinTrack[i].t - chinTrack[i - 1].t);
        if (worstGap > 2) {
          console.log(`  QA WARNING: face not detected for a ${worstGap.toFixed(1)}s stretch — framing/captions unverified there`);
        } else {
          console.log(`  QA: face tracked continuously (max gap ${worstGap.toFixed(1)}s); captions pinned below measured chin at every chunk`);
        }
      }
    } else if (opts.captionsBasic) {
      console.log("Burning captions (basic)...");
      const o = next();
      await burnCaptions(cur, o, transcript!.segments);
      cur = o;
    }

    // Final: copy the working file(s) to the requested output.
    const meta = await probe(cur);
    const { ffmpeg } = await import("./lib/ffmpeg.js");
    await ffmpeg(["-i", cur, "-c", "copy", opts.output], "finalize");
    if (opts.mirrorClone) {
      const mirrorPath = opts.output.replace(/\.([a-z0-9]+)$/i, "_mirror.$1");
      // If captions didn't run, mirror the finished main output instead.
      const src = mirrorCur ?? cur;
      if (mirrorCur) await ffmpeg(["-i", src, "-c", "copy", mirrorPath], "finalize-mirror");
      else await flipStep(src, mirrorPath, "h");
      console.log(`Mirror clone -> ${mirrorPath}`);
    }
    if (duoCur) {
      const trialPath = opts.output.replace(/\.([a-z0-9]+)$/i, "_trial.$1");
      await ffmpeg(["-i", duoCur, "-c", "copy", trialPath], "finalize-trial");
      console.log(`Duo trial -> ${trialPath}`);
    }
    if (opts.postCaption || opts.cover) {
      const text = transcript
        ? transcript.segments.map((s) => s.text).join(" ")
        : (await transcribe(cur)).segments.map((s) => s.text).join(" ");
      if (opts.postCaption) {
        const capPath = opts.output.replace(/\.[a-z0-9]+$/i, ".caption.txt");
        console.log("Writing post caption...");
        const preCaption = opts.captionFile ? await readFile(opts.captionFile, "utf8") : undefined;
        const caption = await writePostCaption(text, capPath, cardCta, preCaption);
        console.log(`Post caption -> ${capPath}\n---\n${caption}\n---`);
        let mirrorCaption: string | undefined;
        if (opts.mirrorClone) {
          const mirrorCapPath = opts.output.replace(/\.[a-z0-9]+$/i, "_mirror.caption.txt");
          mirrorCaption = await writeMirrorCaption(caption, text, mirrorCapPath);
          console.log(`Mirror caption -> ${mirrorCapPath}\n---\n${mirrorCaption}\n---`);
        }
        if (opts.duoTrial) {
          const trialCapPath = opts.output.replace(/\.[a-z0-9]+$/i, "_trial.caption.txt");
          const avoid = mirrorCaption
            ? `${text}\n\nA second variant already exists — do NOT resemble it either:\n${mirrorCaption}`
            : text;
          const trialCaption = await writeMirrorCaption(caption, avoid, trialCapPath);
          console.log(`Trial caption -> ${trialCapPath}\n---\n${trialCaption}\n---`);
        }
      }
      if (opts.cover) {
        const coverPath = opts.output.replace(/\.[a-z0-9]+$/i, ".cover.png");
        const mirrorCoverPath = opts.mirrorClone
          ? opts.output.replace(/\.[a-z0-9]+$/i, "_mirror.cover.png")
          : undefined;
        const preCover = opts.coverJson ? JSON.parse(await readFile(opts.coverJson, "utf8")) : undefined;
        console.log("Generating cover...");
        // Cover uses the ORIGINAL wide footage, not the zoomed edit — a wider
        // scene with breathing room reads inviting; the tight crop reads harsh.
        await makeCover(input, text, coverPath, mirrorCoverPath, preCover);
        console.log(`Cover -> ${coverPath}${mirrorCoverPath ? ` + ${mirrorCoverPath}` : ""}`);
        // Bake covers into the first frames (IG has no thumbnail API via
        // Postiz; the PNGs stay alongside for YouTube/manual use).
        console.log("Baking cover into video start...");
        const tmpMain = opts.output.replace(/\.([a-z0-9]+)$/i, ".tmp.$1");
        await prependCover(opts.output, coverPath, tmpMain);
        await rename(tmpMain, opts.output).catch(async () => {
          await copyFile(tmpMain, opts.output);
          await unlink(tmpMain);
        });
        if (opts.mirrorClone && mirrorCoverPath) {
          const mirrorPath = opts.output.replace(/\.([a-z0-9]+)$/i, "_mirror.$1");
          const tmpMirror = mirrorPath.replace(/\.([a-z0-9]+)$/i, ".tmp.$1");
          await prependCover(mirrorPath, mirrorCoverPath, tmpMirror);
          await rename(tmpMirror, mirrorPath).catch(async () => {
            await copyFile(tmpMirror, mirrorPath);
            await unlink(tmpMirror);
          });
        }
        if (duoCur) {
          const trialPath = opts.output.replace(/\.([a-z0-9]+)$/i, "_trial.$1");
          const tmpTrial = trialPath.replace(/\.([a-z0-9]+)$/i, ".tmp.$1");
          await prependCover(trialPath, coverPath, tmpTrial);
          await rename(tmpTrial, trialPath).catch(async () => {
            await copyFile(tmpTrial, trialPath);
            await unlink(tmpTrial);
          });
        }
      }
    }
    console.log(
      `\nDone -> ${opts.output}  (${meta.width}x${meta.height}, ${meta.durationSec.toFixed(1)}s)`,
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function printPlan(placements: BrollPlacement[]) {
  if (placements.length === 0) {
    console.log("  (no b-roll placements proposed)");
    return;
  }
  console.log("Proposed b-roll:");
  for (const p of placements) {
    const end = (p.start + p.duration).toFixed(1);
    console.log(
      `  ${p.start.toFixed(1)}-${end}s  ${p.file}${p.reason ? `  — ${p.reason}` : ""}`,
    );
  }
}

program.parseAsync().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
