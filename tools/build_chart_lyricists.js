import fs from "fs";

const text = fs.readFileSync("D:/sunomaster/排行榜歌曲词作者.txt", "utf8").replace(/^\uFEFF/, "");
const lines = text.split(/\r?\n/).filter((line) => line && !line.startsWith("歌名\t"));
function nameKey(value) {
  return String(value || "")
    .replace(/（[^）]*）/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[·・.\s]/g, "")
    .toLowerCase();
}

const authors = new Map();
let credited = 0;
for (const line of lines) {
  const [songName, singerName, , , lyricists, , status] = line.split("\t");
  if (status !== "ok" || !lyricists) continue;
  credited += 1;
  for (const name of lyricists.split("、").map((item) => item.trim()).filter(Boolean)) {
    const key = nameKey(name);
    let author = authors.get(key);
    if (!author) {
      author = { name, count: 0, songs: [] };
      authors.set(key, author);
    }
    const songKey = `${songName}\t${singerName}`;
    if (!author.songs.some((song) => `${song.title}\t${song.artist}` === songKey)) {
      author.songs.push({ title: songName, artist: singerName });
    }
  }
}
for (const author of authors.values()) author.count = author.songs.length;
const list = [...authors.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh"));
const payload = { updated: "2026-11-13", songs: credited, authors: list.length, list };
fs.writeFileSync("D:/sunomaster/public/chart-lyricists.json", JSON.stringify(payload));
console.log("AUTHORS", list.length, "SONGS", credited, "BYTES", JSON.stringify(payload).length);
