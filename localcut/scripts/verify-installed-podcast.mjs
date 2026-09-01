import { extractFile } from "@electron/asar";

const archivePath = process.argv[2];
if (!archivePath) throw new Error("Pass the installed app.asar path");
const read = (path) => extractFile(archivePath, path).toString("utf8");
const backend = read("src/podcast.mjs");
const html = read("desktop\\renderer\\index.html");
const renderer = read("desktop\\renderer\\app.js");
const checks = {
  announcementPathEmbedded: backend.includes("FromBase64String") && !backend.includes("$args[0]"),
  announcementScanReceipted: backend.includes("announcementScan"),
  humFundamental: backend.includes("equalizer=f=${normalized.humFrequency}:t=q:w=20:g=-30"),
  humHarmonics: backend.includes("normalized.humFrequency * 2") && backend.includes("normalized.humFrequency * 3"),
  humControlVisible: html.includes('id="podcastRemoveHum"') && html.includes("Remove Focusrite / electrical hum"),
  humControlWired: renderer.includes('removeElectricalHum: $("#podcastRemoveHum").checked'),
  humProofVisible: renderer.includes("Electrical hum removed"),
  clarityControlVisible: html.includes('id="podcastClarity"') && html.includes("Voice clarity"),
  clarityControlWired: renderer.includes('clarity: Number($("#podcastClarity").value)'),
  clearerVoiceProfile: backend.includes('voiceProfile: "Deep, clear, and present"') && backend.includes("gentlerDenoising: true"),
};
console.log(JSON.stringify(checks, null, 2));
if (Object.values(checks).some((value) => !value)) process.exitCode = 2;
