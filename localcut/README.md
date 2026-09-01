# LocalCut

LocalCut is a clean-room, local-first reconstruction of ChatCut's agent-facing
editing pattern. It does not patch ChatCut, call ChatCut services, or require a
ChatCut account. Projects are JSON files, media is inspected and rendered with
local FFmpeg, and an AI client controls the editor through MCP.

## Current working slice

- Create/list/select projects.
- Import and FFprobe local video/audio.
- Read the complete project/timeline state.
- Atomically add, update, and delete timeline clips with overlap validation.
- Split clips while preserving source offsets.
- Export sequential V1 clips locally to H.264/AAC MP4.
- Build, checkpoint, resume, and QA multi-reel talking-head pipelines through
  AutoEditPost stage graphs.
- Run as a small stdio MCP server with project-local FFmpeg binaries.

The Windows desktop app combines a nonlinear editing workspace with the
complete talking-head graph. Projects, assets, transcript text, timeline clips,
versions, renders, QA, and automation remain backed by the same local engine
available through MCP and the command-line runner.

## Windows editor

Install with `LocalCut-Setup-0.8.5-x64.exe`, then open **LocalCut** from the
desktop or Start menu. The clean-room AutoEditPost Studio provides a complete
local editing workspace with:

- An AI workflow panel connected to local editor and pipeline actions.
- Searchable media bins, a template library, and text-based caption editing.
- A live aspect-ratio-aware viewer with playback and caption controls.
- V2, V1, and A1 timeline tracks with select, trim, blade, split, snap, zoom,
  keyboard shortcuts, drag-to-track, undo, and redo.
- A project library with duplication, deletion, local versions, and workspace
  presets.
- Local FFmpeg export and a resumable seven-stage automation drawer with the
  complete QA gallery.

The app keeps its resumable project and job state under
`%USERPROFILE%/.localcut` and uses local FFmpeg binaries. When a private ingest
server is configured, new media can also be streamed to that server while the
Windows editor retains its local source path.

## Uploading media to the MCP host

The desktop upload button and the `upload_media_to_server` MCP tool stream the
selected file to a companion ingest endpoint. The transfer is authenticated,
written atomically, and accepted only when the server and client agree on both
the byte count and SHA-256 hash. Configure the Windows client in
`%USERPROFILE%\.localcut\upload.json`:

```json
{
  "url": "http://127.0.0.1:4178/v1/uploads",
  "token": "generated-server-token"
}
```

The Linux service template is `deploy/localcut-upload.service`; the server entry
point is `src/upload-server.mjs`. Keep the token in `/etc/localcut-upload.env`
with restricted permissions rather than embedding it in the application.

The automated talking-head workflow remains:

1. Import or select the long source video in **My Assets**.
2. Open **Automation** and press **Run / resume batch**.
3. Follow the seven-stage graph for every reel or keep editing the timeline.
4. Preview passed outputs in the QA gallery or reveal them in Explorer.

The installed executable also doubles as a local MCP server. Copy the ready-made
configuration from **Agent settings** or the Automation drawer.

## Run

Requires Node.js 20+ and FFmpeg/FFprobe on `PATH`.

```sh
npm run check
npm test
npm start          # desktop app
npm run mcp        # local stdio MCP server
npm run dist:win   # Windows installer
```

Data defaults to `~/.localcut/state.json`. Override with `LOCALCUT_DATA_DIR`.
Override binaries with `FFMPEG_PATH` and `FFPROBE_PATH`.

## MCP configuration

Point an MCP-capable client at Node and the absolute server path:

```json
{
  "mcpServers": {
    "localcut": {
      "command": "node",
      "args": ["/absolute/path/to/localcut/src/server.mjs"],
      "env": { "LOCALCUT_DATA_DIR": "/absolute/path/to/localcut-data" }
    }
  }
}
```

The transport is newline-delimited JSON-RPC over stdio, matching the essential
shape of ChatCut's bridge but implemented independently.

`mcp-config.example.json` is a ready-to-copy MCP
entry; adjust the paths for your machine. API keys are not
stored in that file; add transcription provider settings to the MCP client's
environment only when a caption stage actually needs to be regenerated.

## Talking-head batch

The graph is `cut -> clean -> tighten -> speed -> captions -> render -> QA` for
every manifest entry, joined by one final batch node. It resumes from fresh
artifacts and retries failed nodes. On Windows the bundled FFmpeg executables are
copied once to `%LOCALAPPDATA%/LocalCut/bin`, because executables cannot launch
directly from this NAS share.

```powershell
node src/pipeline-cli.mjs run `
  --name "Reliability batch" `
  --input "..\..\AutoEditPost\Raw\726_53192.MP4" `
  --manifest "..\..\AutoEditPost\out\yaps\yap_cutlists.json" `
  --out "..\..\AutoEditPost\out\yaps" `
  --aep "..\..\AutoEditPost" `
  --concurrency 2
```

For MCP, use `create_talking_head_pipeline`, then
`run_talking_head_pipeline`, and poll `read_talking_head_pipeline`. See
`PIPELINE_PLAN.md` for the graph, retry, and QA contracts.
