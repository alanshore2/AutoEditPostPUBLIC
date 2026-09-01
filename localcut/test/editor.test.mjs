import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEditorEngine } from "../src/editor-engine.mjs";

test("local editor projects support settings, undo, redo, and named versions", async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), "localcut-editor-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const editor = createEditorEngine({ dataDir });

  const created = await editor.call("create_project", { name: "Studio", width: 1080, height: 1920, fps: 30 });
  assert.equal(created.name, "Studio");
  await editor.call("update_project", { name: "First Cut", settings: { captions: false } });
  assert.equal((await editor.call("read_project")).name, "First Cut");

  await editor.call("undo_project");
  assert.equal((await editor.call("read_project")).name, "Studio");
  await editor.call("redo_project");
  assert.equal((await editor.call("read_project")).name, "First Cut");

  const version = await editor.call("save_project_version", { name: "Review ready" });
  assert.equal(version.name, "Review ready");
  assert.equal((await editor.call("list_project_versions")).versions.length, 1);

  const duplicate = await editor.call("duplicate_project", {});
  assert.match(duplicate.name, /Copy$/);
  assert.notEqual(duplicate.id, created.id);
});
