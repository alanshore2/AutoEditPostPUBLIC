import { createPodcastManager } from "../src/podcast.mjs";

const sourcePath = process.argv[2];
if (!sourcePath) throw new Error("Pass an audio or video file path");
const manager = createPodcastManager();
const receipt = await manager.process(sourcePath, {}, (progress) => {
  console.log(JSON.stringify({ type: "progress", ...progress }));
});
console.log(JSON.stringify({ type: "result", receipt }));
