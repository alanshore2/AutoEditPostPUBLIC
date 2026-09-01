import { writeFile } from "node:fs/promises";

const key = String(process.env.POSTIZ_KEY || "").trim();
const apiUrl = String(process.env.POSTIZ_API_URL || "https://api.postiz.com/public/v1").replace(/\/$/, "");
if (!key) throw new Error("The in-memory Postiz credential was not provided");

const start = new Date(process.env.LOCALCUT_POSTIZ_START || Date.now() - 86400000);
const end = new Date(process.env.LOCALCUT_POSTIZ_END || Date.now() + 14 * 86400000);
const chunkDays = Math.max(1, Math.min(3, Number(process.env.LOCALCUT_POSTIZ_CHUNK_DAYS) || 1));
const posts = new Map();
for (let cursor = start.getTime(); cursor < end.getTime(); cursor += chunkDays * 86400000) {
  const chunkEnd = Math.min(end.getTime(), cursor + chunkDays * 86400000);
  const url = `${apiUrl}/posts?startDate=${encodeURIComponent(new Date(cursor).toISOString())}&endDate=${encodeURIComponent(new Date(chunkEnd).toISOString())}`;
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 45000);
  let response;
  try { response = await fetch(url, { headers: { Authorization: key }, signal: controller.signal }); }
  finally { clearTimeout(timer); }
  const text = await response.text(); let payload;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { error: text.slice(0, 500) }; }
  if (!response.ok) throw new Error(`Postiz queue read failed (${response.status}): ${JSON.stringify(payload).slice(0, 300)}`);
  for (const post of Array.isArray(payload) ? payload : Array.isArray(payload?.posts) ? payload.posts : []) posts.set(post.id, post);
}
const records = [...posts.values()].sort((a, b) => Date.parse(a.publishDate) - Date.parse(b.publishDate));
const result = { checkedAt: new Date().toISOString(), range: { start: start.toISOString(), end: end.toISOString() },
  count: records.length, keys: [...new Set(records.flatMap((post) => Object.keys(post)))].sort(), posts: records };
const output = String(process.env.LOCALCUT_POSTIZ_OUTPUT || "").trim();
if (output) {
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ...result, posts: undefined, output })}\n`);
} else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
