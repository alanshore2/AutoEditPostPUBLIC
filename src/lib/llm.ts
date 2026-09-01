/**
 * Minimal Anthropic Messages API client (no SDK dependency).
 * Requires ANTHROPIC_API_KEY. Model via ANTHROPIC_MODEL (default claude-sonnet-5).
 */
export async function askClaudeJSON<T>(system: string, user: string): Promise<T> {
  try {
    return await askClaudeJSONOnce<T>(system, user);
  } catch (err: any) {
    // One retry with the parse error surfaced — models occasionally emit
    // unescaped newlines/quotes inside strings.
    return askClaudeJSONOnce<T>(
      system,
      `${user}\n\n(Your previous reply failed to parse: ${String(err.message).slice(0, 200)}. Respond again with ONLY strictly valid single-line JSON; escape line breaks as \\n.)`,
    );
  }
}

async function askClaudeJSONOnce<T>(system: string, user: string): Promise<T> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is required for b-roll matching");
  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
  const base = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";

  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic API failed (${res.status}): ${await res.text()}`);
  }
  const data: any = await res.json();
  const text = (data.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
  return extractJSON<T>(text);
}

/** Pull the first JSON object/array out of a model response, tolerating fences. */
function extractJSON<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.search(/[[{]/);
  if (start === -1) throw new Error(`No JSON found in model output:\n${text.slice(0, 500)}`);
  // Walk to the matching closing bracket.
  const open = candidate[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  for (let i = start; i < candidate.length; i++) {
    if (candidate[i] === open) depth++;
    else if (candidate[i] === close) {
      depth--;
      if (depth === 0) return JSON.parse(candidate.slice(start, i + 1));
    }
  }
  throw new Error(`Unbalanced JSON in model output:\n${text.slice(0, 500)}`);
}
