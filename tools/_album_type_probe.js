import fs from "fs";
import { hikoonPost } from "../lib/hikoon.js";

for (const line of fs.readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
  const index = trimmed.indexOf("=");
  const name = trimmed.slice(0, index).trim();
  let value = trimmed.slice(index + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (!process.env[name]) process.env[name] = value;
}

const data = await hikoonPost("/open-api/publish/constant", {});
const album = data?.album?.album_type ?? data?.album?.version ?? null;
console.log(JSON.stringify({ album_type: data?.album?.album_type ?? null, albumKeys: Object.keys(data?.album || {}) }, null, 2));
