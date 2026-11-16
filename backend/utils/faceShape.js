/**
 * Face shape from a selfie, on this server (no paid API).
 *
 * face-api (TensorFlow.js, WASM backend - no native build) finds the face and its 68 landmarks; the
 * shape comes from simple proportions: face length vs cheek width, and jaw / forehead width vs cheeks.
 * Models load on the first photo only, so accounts that never use hairstyle ideas pay no RAM for it.
 */
const path = require("path");
const jpeg = require("jpeg-js");

const SHAPES = ["oval", "round", "square", "long", "heart"];
let ready = null;

function load() {
  if (!ready) {
    ready = (async () => {
      const faceapi = require("@vladmandic/face-api/dist/face-api.node-wasm.js");
      const tf = faceapi.tf;
      const wasm = require("@tensorflow/tfjs-backend-wasm");
      wasm.setWasmPaths(path.join(path.dirname(require.resolve("@tensorflow/tfjs-backend-wasm")), path.sep));
      await tf.setBackend("wasm");
      await tf.ready();
      const modelDir = path.join(path.dirname(require.resolve("@vladmandic/face-api/package.json")), "model");
      await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelDir);
      await faceapi.nets.faceLandmark68Net.loadFromDisk(modelDir);
      return { faceapi, tf };
    })().catch((error) => { ready = null; throw error; });
  }
  return ready;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** 68 landmark points -> shape name. Exported so the thresholds can be tested without a photo. */
function classify(points) {
  const p = points;
  const cheek = dist(p[1], p[15]);
  const jaw = dist(p[4], p[12]);
  const forehead = dist(p[17], p[26]);
  const browMid = mid(p[19], p[24]);
  // Forehead height ~ brow-to-nose-base (the "facial thirds" rule); the hairline is not a landmark.
  const length = dist(p[8], browMid) + dist(browMid, p[33]);
  const ratio = length / cheek;
  const jawRatio = jaw / cheek; // typical faces measure ~0.77-0.82
  const foreheadRatio = forehead / cheek;
  let shape;
  if (ratio >= 1.55) shape = "long";
  else if (jawRatio >= 0.84) shape = "square";
  else if (jawRatio <= 0.74) shape = "heart";
  else if (ratio < 1.32) shape = "round";
  else shape = "oval";
  return { shape, ratio: +ratio.toFixed(2), jawRatio: +jawRatio.toFixed(2), foreheadRatio: +foreheadRatio.toFixed(2) };
}

/** JPEG/PNG buffer -> { shape, ... } or { shape: null, reason } when no single clear face is found. */
async function detect(buffer) {
  const { faceapi, tf } = await load();
  let raw;
  try { raw = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: false, maxMemoryUsageInMB: 256 }); }
  catch { return { shape: null, reason: "unreadable" }; }
  const input = tf.tensor3d(raw.data, [raw.height, raw.width, 3], "int32");
  try {
    const faces = await faceapi.detectAllFaces(input, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 })).withFaceLandmarks();
    if (!faces.length) return { shape: null, reason: "noface" };
    // Several faces: use the biggest (the person holding the phone).
    const face = faces.sort((a, b) => b.detection.box.area - a.detection.box.area)[0];
    if (face.detection.box.width < 80) return { shape: null, reason: "small" };
    return classify(face.landmarks.positions);
  } finally {
    input.dispose();
  }
}

module.exports = { detect, classify, SHAPES };
