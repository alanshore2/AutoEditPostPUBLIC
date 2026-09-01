import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";

export async function computeReelApprovalRevision(paths = {}) {
  const entries = [];
  for (const [name, path] of Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))) {
    if (!path) return null;
    try {
      const info = await stat(path);
      entries.push([name, info.size, Math.round(info.mtimeMs)]);
    } catch { return null; }
  }
  return entries.length ? createHash("sha256").update(JSON.stringify(entries)).digest("hex") : null;
}

export function resolveReelApproval(review, revision) {
  const approval = review?.approval && typeof review.approval === "object" ? review.approval : {};
  const requested = approval.status === "approved";
  const approved = Boolean(requested && revision && approval.revision === revision);
  return {
    status: approved ? "approved" : requested ? "expired" : "pending",
    approved,
    stale: requested && !approved,
    approvedAt: approved ? approval.approvedAt || approval.updatedAt || null : null,
    invalidatedAt: approval.invalidatedAt || null,
    invalidatedBy: approval.invalidatedBy || null,
    revision,
  };
}
