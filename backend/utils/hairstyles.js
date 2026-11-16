/**
 * The salon's hairstyle photos for Bot 2 "Hairstyle ideas", grouped by face shape.
 * Stored at data/hairstyles/<mobile>/index.json + one JPEG per photo, kept out of the bot JSON
 * (which is rewritten on every message).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { writeJsonAtomic } = require("./atomicWrite");
const { SHAPES } = require("./faceShape");

const ROOT = path.join(__dirname, "..", "data", "hairstyles");
const MAX_PER_SHAPE = 6;
const MAX_BYTES = 3 * 1024 * 1024;

const dir = (mobile) => path.join(ROOT, String(mobile).replace(/\D/g, ""));
const indexFile = (mobile) => path.join(dir(mobile), "index.json");

function list(mobile) {
  try { return JSON.parse(fs.readFileSync(indexFile(mobile), "utf8")); } catch { return []; }
}

function add(mobile, { shape, name = "", dataUrl = "" }) {
  if (!SHAPES.includes(shape)) throw new Error("Choose a face shape.");
  const match = /^data:image\/jpe?g;base64,(.+)$/i.exec(String(dataUrl));
  if (!match) throw new Error("Please upload a JPG photo.");
  const buffer = Buffer.from(match[1], "base64");
  if (buffer.length > MAX_BYTES) throw new Error("Photo is too large (max 3 MB).");
  const items = list(mobile);
  if (items.filter((item) => item.shape === shape).length >= MAX_PER_SHAPE) throw new Error(`Up to ${MAX_PER_SHAPE} photos per face shape.`);
  const id = crypto.randomBytes(6).toString("hex");
  fs.mkdirSync(dir(mobile), { recursive: true });
  fs.writeFileSync(path.join(dir(mobile), `${id}.jpg`), buffer);
  items.push({ id, shape, name: String(name).trim().slice(0, 60), addedAt: Date.now() });
  writeJsonAtomic(indexFile(mobile), items);
  return items;
}

function remove(mobile, id) {
  const items = list(mobile);
  const next = items.filter((item) => item.id !== id);
  if (next.length !== items.length) {
    writeJsonAtomic(indexFile(mobile), next);
    try { fs.unlinkSync(path.join(dir(mobile), `${String(id).replace(/[^a-f0-9]/g, "")}.jpg`)); } catch { /* already gone */ }
  }
  return next;
}

function photo(mobile, id) {
  return fs.readFileSync(path.join(dir(mobile), `${String(id).replace(/[^a-f0-9]/g, "")}.jpg`));
}

/** Photos for one shape, falling back to "oval" styles (they suit most faces) when that shape has none. */
function forShape(mobile, shape) {
  const items = list(mobile);
  const own = items.filter((item) => item.shape === shape);
  return own.length ? own : items.filter((item) => item.shape === "oval");
}

module.exports = { list, add, remove, photo, forShape, MAX_PER_SHAPE };
