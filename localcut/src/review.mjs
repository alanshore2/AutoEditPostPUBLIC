const COMMON_OPENERS = new Set(["a", "an", "the", "how", "why"]);

const cleanLine = (value, limit) => String(value || "")
  .replace(/[\r\n]+/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, limit);

export function defaultCoverCopy(title, reel = "") {
  const words = cleanLine(title, 120).replace(/[,:;.!?]+$/g, "").split(" ").filter(Boolean);
  const accentWords = words.length > 2 && COMMON_OPENERS.has((words[0] || "").toLowerCase()) ? 2 : 1;
  const accent = words.slice(0, Math.min(accentWords, words.length)).join(" ") || `REEL ${String(reel).padStart(2, "0")}`;
  const headline = words.slice(Math.min(accentWords, words.length)).join(" ") || "READY TO REVIEW";
  return { kicker: "APPOINTMENT AUDIT", accent, headline };
}

export function normalizeCoverCopy(value, title, reel = "") {
  const fallback = defaultCoverCopy(title, reel);
  const source = value && typeof value === "object" ? value : {};
  const supplied = ["kicker", "accent", "headline"].some((key) => Object.hasOwn(source, key));
  if (!supplied) return fallback;
  const copy = {
    kicker: cleanLine(source.kicker, 48),
    accent: cleanLine(source.accent, 48),
    headline: cleanLine(source.headline, 80),
  };
  return copy.kicker || copy.accent || copy.headline ? copy : fallback;
}

export function isFaceSafeCaptionY(value) {
  const y = Number(value);
  return Number.isFinite(y) && (y >= 1200 || y <= 600);
}

export function coverCandidateTimes(durationValue, selectedValue = null) {
  const duration = Math.max(0, Number(durationValue) || 0);
  if (duration <= 0.1) return [0];
  const lastFrame = Math.max(0, duration - 0.08);
  const selected = Number(selectedValue);
  const proposed = [
    ...(Number.isFinite(selected) ? [selected] : []),
    ...[0.08, 0.18, 0.3, 0.42, 0.54, 0.66, 0.78, 0.88].map((fraction) => duration * fraction),
    Math.max(0, duration - 0.8),
    Math.max(0, duration - 0.35),
    lastFrame,
  ];
  const times = [];
  for (const candidate of proposed) {
    const at = Math.max(0, Math.min(lastFrame, candidate));
    if (times.some((existing) => Math.abs(existing - at) < 0.24)) continue;
    times.push(Number(at.toFixed(3)));
    if (times.length === 12) break;
  }
  return times;
}

const seoList = (value) => (Array.isArray(value) ? value : String(value || "").split(/[,\n]+/))
  .map((item) => cleanLine(item, 100)).filter(Boolean);

export function normalizeSeoPackage(value = {}, fallback = {}) {
  const source = value && typeof value === "object" ? value : {};
  const base = fallback && typeof fallback === "object" ? fallback : {};
  const primaryPhrase = cleanLine(source.primaryPhrase || base.primaryPhrase, 120);
  const relatedSource = source.related?.length ? source.related : base.related;
  const hashtagSource = source.hashtags?.length ? source.hashtags : base.hashtags;
  const dedupe = (values, limit) => {
    const seen = new Set(), result = [];
    for (const item of values) {
      const key = item.toLowerCase(); if (!item || seen.has(key)) continue;
      seen.add(key); result.push(item); if (result.length === limit) break;
    }
    return result;
  };
  const related = dedupe(seoList(relatedSource).filter((item) => item.toLowerCase() !== primaryPhrase.toLowerCase()), 8);
  const hashtags = dedupe(seoList(hashtagSource).map((item) => {
    const tag = item.replace(/^#+/, "").replace(/[^a-z0-9_]+/gi, ""); return tag ? `#${tag}` : "";
  }).filter(Boolean), 8);
  const keywords = dedupe([primaryPhrase, ...related].filter(Boolean), 9);
  return { primaryPhrase, related, hashtags, keywords, metadataKeywords: keywords.join(", ") };
}
