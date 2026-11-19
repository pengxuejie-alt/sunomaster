# -*- coding: utf-8 -*-
"""Map each lyricist to how many lyric files we actually hold."""

import json
from pathlib import Path

ROOT = Path(r"D:\sunomaster")
LYRIC = Path(r"D:\lyricmaster")
CATALOG = LYRIC / "lyric" / "_词作者目录.txt"
SKILLS = LYRIC / ".cursor" / "skills"
OUT = ROOT / "public" / "lyric-written.json"


def folder_counts():
    counts = {}
    for folder in (LYRIC / "lyric").iterdir():
        if not folder.is_dir():
            continue
        count = sum(1 for _ in folder.glob("*.txt"))
        if count:
            counts[folder.name] = count
    return counts


def catalog_names():
    found = {}
    if not CATALOG.exists():
        return found
    for line in CATALOG.read_text(encoding="utf-8").splitlines():
        parts = line.split("\t")
        if len(parts) < 2 or parts[0] in {"中文名", "排行榜词作者目录对照"}:
            continue
        name, folder = parts[0].strip(), parts[1].strip()
        if name and folder and " " not in folder:
            found.setdefault(folder, []).append(name)
    return found


def skill_names():
    found = {}
    for path in SKILLS.glob("*/skill.json"):
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("kind") != "lyricist":
            continue
        found[data["id"].replace("-", "").lower()] = data["name"]
    return found


def main():
    folders = folder_counts()
    by_folder = catalog_names()
    skills = skill_names()
    written = {}
    for folder, count in folders.items():
        names = list(by_folder.get(folder, []))
        key = folder.replace("-", "").replace("_", "").lower()
        skill_name = skills.get(key)
        if skill_name and skill_name not in names:
            names.append(skill_name)
        for name in names:
            written[name] = max(written.get(name, 0), count)
    payload = {
        "updated": "2026-11-14",
        "authors": len(written),
        "byName": dict(sorted(written.items(), key=lambda item: (-item[1], item[0]))),
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    classics = ["林夕", "黄伟文", "黄霑", "姚谦", "李宗盛", "罗大佑", "方文山", "林振强", "周耀辉", "郑国江", "小虫", "姚若龙"]
    print("authors", len(written), "out", OUT)
    for name in classics:
        print(f"{written.get(name, 0):5} {name}")


if __name__ == "__main__":
    main()
