/**
 * Crash-safe JSON writes. A plain fs.writeFileSync can be interrupted mid-write (power cut,
 * OOM kill, server restart), leaving a half-written - and so unreadable - file. Here the data
 * is written to a temp file in the same folder first and then renamed over the target. A rename
 * on the same filesystem is atomic, so a crash leaves either the old complete file or the new
 * complete file, never a corrupt mix. At 100+ accounts, where writes happen far more often, this
 * is the difference between one account losing its last change and its whole file going bad.
 */
const fs = require("fs");
const path = require("path");

function writeJsonAtomic(file, data, { pretty = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, pretty ? 2 : undefined));
  fs.renameSync(tmp, file);
}

module.exports = { writeJsonAtomic };
