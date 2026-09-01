export interface TranscriptSegment {
  /** Seconds from start of clip. */
  start: number;
  /** Seconds from start of clip. */
  end: number;
  text: string;
}

export interface Word {
  /** The word, trimmed (no surrounding whitespace). */
  word: string;
  /** Seconds from start of clip. */
  start: number;
  /** Seconds from start of clip. */
  end: number;
}

export interface Transcript {
  /** Sentence/phrase-level segments (captions basic mode, b-roll matching). */
  segments: TranscriptSegment[];
  /** Word-level timings (dynamic captions). May be empty if unavailable. */
  words: Word[];
}

export interface BrollClip {
  /** Filename relative to the b-roll directory, e.g. "calendar-closeup.mp4". */
  file: string;
  /** Human/AI description of what the clip shows. Drives matching. */
  description: string;
  /** Optional keyword tags. */
  tags?: string[];
  /** Cached duration in seconds (filled in by `index` command). */
  durationSec?: number;
}

export interface BrollLibrary {
  clips: BrollClip[];
}

export interface BrollPlacement {
  /** Which library clip to use. */
  file: string;
  /** When the cutaway starts, in seconds into the A-roll. */
  start: number;
  /** How long the cutaway lasts, in seconds. */
  duration: number;
  /** Why the model chose it (for the approval step / logs). */
  reason?: string;
}
