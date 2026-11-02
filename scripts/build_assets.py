# -*- coding: utf-8 -*-
"""Build web assets from the EPUB workspace:

  content/original.json   原文（按篇/节）
  content/marks.json      EPUB 记号词表（概念/人物/地名/古今异义/关键词）
  fonts/*.woff2           楷体、宋体、标题字体的网页子集
  fonts/fonts.css         @font-face
  fonts/licenses/*        字体许可

Run from repo root:  python scripts/build_assets.py
(Requires the local EPUB workspace at D:\\library\\古籍\\古籍增强工坊)
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = r"D:\library\古籍\古籍增强工坊"
BOOK = os.path.join(WORK, "books", "zhuangzi")
DATA = os.path.join(BOOK, "data")
STRUCT = os.path.join(BOOK, "source", "structure.json")
FONT_BUILD = os.path.join(WORK, "work", "build", "zhuangzi", "OEBPS", "fonts")
LICENSE_SRC = os.path.join(WORK, "fonts", "licenses")

CJK = re.compile(r"[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]")


def read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def clean(text: str) -> str:
    text = text.replace("\u00a0", " ")
    text = re.sub(r"[ \t\r\n]+", "", text)
    return text.strip()


def _plain_without_notes(el):
    """取元素文本，跳过注号锚点，保留 .glyph 内的生僻字。"""
    out = []
    def rec(e):
        local = e.tag.split('}')[-1]
        cls = e.get('class') or ''
        if local == 'a' and 'noteref' in cls:
            return
        if e.text:
            out.append(e.text)
        for c in e:
            rec(c)
            if c.tail:
                out.append(c.tail)
    rec(el)
    return ''.join(out)


def _built_original():
    """优先从构建后的 EPUB XHTML 取原文：里面的生僻字已经从字形图片还原成真字。"""
    text_dir = os.path.join(WORK, "work", "build", "zhuangzi", "OEBPS", "text")
    if not os.path.isdir(text_dir):
        return {}
    import glob
    import xml.etree.ElementTree as ET
    got = {}
    for path in sorted(glob.glob(os.path.join(text_dir, "part*.html"))):
        try:
            root = ET.parse(path).getroot()
        except ET.ParseError:
            continue
        title = ''
        for e in root.iter():
            cls = e.get('class') or ''
            if e.tag.split('}')[-1] == 'h1' and 'chapter-title' in cls:
                title = ' '.join(''.join(e.itertext()).split())
                break
        if not title:
            continue
        sections, cur = [], None
        for e in root.iter():
            local = e.tag.split('}')[-1]
            cls = e.get('class') or ''
            if local == 'h2' and 'sec-title' in cls:
                cur = []
                sections.append(cur)
            elif local == 'p' and 'source' in cls and cur is not None:
                t = ' '.join(_plain_without_notes(e).split())
                if t:
                    cur.append(t)
        if sections:
            got[title] = sections
    return got


def build_original():
    st = read_json(STRUCT)
    built = _built_original()
    chapters = []
    group_rank = {"内篇": 0, "外篇": 1, "杂篇": 2}
    order = sorted(st["chapters"], key=lambda c: (group_rank.get(c.get("group"), 9), int(c["no"])))
    for idx, ch in enumerate(order, 1):
        built_secs = built.get(ch["title"].strip())
        sections = []
        for i, sec in enumerate(ch["sections"]):
            if built_secs and len(built_secs) == len(ch["sections"]):
                texts = built_secs[i][:]
            else:
                texts = [clean(p["text"]) for p in sec.get("source", [])]
            texts = [t for t in texts if t]
            if not texts:
                continue
            sections.append({
                "title": sec.get("title_auto") or sec.get("title") or "",
                "texts": texts,
            })
        chapters.append({
            "no": idx,
            "title": ch["title"],
            "part": ch["group"],
            "sections": sections,
        })
    write_json(os.path.join(ROOT, "content", "original.json"), chapters)
    chars = sum(len(t) for c in chapters for s in c["sections"] for t in s["texts"])
    print(f"original.json: {len(chapters)} chapters, {chars} chars")


def build_marks():
    gloss = read_json(os.path.join(DATA, "glossary.json"))
    people = read_json(os.path.join(DATA, "people.json"))
    themes = read_json(os.path.join(DATA, "themes.json"))
    extra = read_json(os.path.join(DATA, "emphasis_extra.json"))

    terms: dict[str, dict] = {}

    def add(t: str, cat: str, info: str = "", prio: int = 5, **extra_fields):
        t = (t or "").strip()
        if not t or len(t) > 12 or not CJK.search(t):
            return
        if t in terms:
            old = terms[t]
            if info and not old.get("info"):
                old["info"] = info
            old["prio"] = min(old["prio"], prio)
            return
        rec = {"t": t, "cat": cat, "prio": prio}
        if info:
            rec["info"] = info
        rec.update(extra_fields)
        terms[t] = rec

    # 概念：术语词典条目 + 别名（保留 brief）
    for c in gloss["concepts"]:
        for t in [c["term"], *c.get("aliases", [])]:
            add(t, "concept", c.get("brief", ""), 1)
    extra_concepts = set(extra.get("concepts", []))
    for t in extra_concepts - set(terms):
        add(t, "concept", "概念 · 《庄子》常用语，见术语词典相关条目。", 2)

    # 人物：人物志条目 + 别名（保留 role / portrait）
    for p in people["people"]:
        for t in [p["name"], *str(p.get("alias", "")).replace("、", " ").split()]:
            add(t, "person", p.get("role", ""), 1, portrait=p.get("portrait", ""))
    for t in set(extra.get("people", [])) - set(terms):
        add(t, "person", "人物 · 《庄子》寓言中出现的人物。", 3)

    # 地名
    for t in extra.get("places", []):
        add(t, "place", "地名 · 《庄子》中出现的地点。", 3)

    # 古今异义
    for t in extra.get("classical_diff", []):
        add(t, "classical", "古今异义：古今词义不同，读时留意。", 4)

    # 关键词（名词 / 主题名），只作粗体，不弹卡
    for t in extra.get("nouns", []):
        add(t, "keyword", "", 5)
    for t in themes["themes"]:
        add(t["name"], "keyword", "", 5)

    # 长词优先，避免“道”先匹配掉“道德”
    arr = sorted(terms.values(), key=lambda r: (-len(r["t"]), r["prio"], r["t"]))
    write_json(os.path.join(ROOT, "content", "marks.json"), {"terms": arr})
    from collections import Counter
    print("marks.json:", Counter(r["cat"] for r in arr), "total", len(arr))


def font_charset():
    texts = []
    texts.append(open(os.path.join(ROOT, "content", "original.json"), encoding="utf-8").read())
    texts.append(open(os.path.join(ROOT, "content", "zhuangzi.json"), encoding="utf-8").read())
    for name in ["index.html"]:
        texts.append(open(os.path.join(ROOT, name), encoding="utf-8").read())
    for base, _, files in os.walk(os.path.join(ROOT, "js")):
        for fn in files:
            if fn.endswith(".js"):
                texts.append(open(os.path.join(base, fn), encoding="utf-8").read())
    text = "".join(texts)
    chars = sorted(set(ch for ch in text if CJK.match(ch)) | set(chr(i) for i in range(32, 127)))
    return "".join(chars)


def subset_font(src: str, dst: str, charset: str):
    font = TTFont(src)
    # keep only needed cmap entries by subsetting with fontTools subsetter
    from fontTools import subset

    opts = subset.Options()
    opts.flavor = "woff2"
    opts.with_zopfli = False
    opts.desubroutinize = True
    opts.name_IDs = ["*"]
    opts.name_languages = ["*"]
    opts.notdef_outline = True
    font = subset.load_font(src, opts)
    subsetter = subset.Subsetter(options=opts)
    subsetter.populate(text=charset)
    subsetter.subset(font)
    subset.save_font(font, dst, opts)
    print(f"  {os.path.basename(dst)}: {os.path.getsize(dst) / 1024:.0f} KB")


def _subset_woff2(src_path, chars, dst, font_number=0):
    font = TTFont(src_path, fontNumber=font_number)
    opts = subset.Options()
    opts.flavor = "woff2"
    opts.desubroutinize = True
    ss = subset.Subsetter(options=opts)
    ss.populate(unicodes=[ord(ch) for ch in chars])
    ss.subset(font)
    font.flavor = "woff2"
    font.save(dst)
    print(f"  {os.path.basename(dst)}: {os.path.getsize(dst) / 1024:.1f} KB ({len(chars)} chars)")


def _font_cmap(path, font_number=0):
    with TTFont(path, fontNumber=font_number) as f:
        out = set()
        for table in f["cmap"].tables:
            out |= set(table.cmap)
    return out


def build_kai_fallback(fonts_dir):
    """Kai 主字体缺的生僻字：常用字用霞鹜文楷，Ext-B 用系统 SimSun-ExtB。"""
    lxgw = os.path.join(WORK, "work", "fonts", "src", "LXGWWenKai-Regular.ttf")
    extb = r"C:\Windows\Fonts\simsunb.ttf"
    kai = os.path.join(fonts_dir, "kai-regular.woff2")
    if not os.path.exists(kai):
        print("skip kai fallback (kai missing)")
        return
    orig = read_json(os.path.join(ROOT, "content", "original.json"))
    chars = sorted({ch for c in orig for s in c["sections"] for t in s["texts"] for ch in t})
    cmap = _font_cmap(kai)
    missing = [ch for ch in chars if ord(ch) not in cmap]
    if not missing:
        print("kai fallback: none needed")
        return
    lxgw_cmap = _font_cmap(lxgw) if os.path.exists(lxgw) else set()
    extb_cmap = _font_cmap(extb) if os.path.exists(extb) else set()
    use_lxgw = [ch for ch in missing if ord(ch) in lxgw_cmap]
    use_extb = [ch for ch in missing if ord(ch) not in lxgw_cmap and ord(ch) in extb_cmap]
    if use_lxgw:
        _subset_woff2(lxgw, use_lxgw, os.path.join(fonts_dir, "kai-fallback.woff2"))
    if use_extb:
        _subset_woff2(extb, use_extb, os.path.join(fonts_dir, "kai-extb.woff2"))
    rest = [ch for ch in missing if ord(ch) not in lxgw_cmap and ord(ch) not in extb_cmap]
    # 剩余的是原书私用区字形（PUA），用系统宋体补最后一个回退；仅个人使用。
    pua_font = r"C:\Windows\Fonts\simsun.ttc"
    if rest and os.path.exists(pua_font):
        pua_cmap = _font_cmap(pua_font)
        use_pua = [ch for ch in rest if ord(ch) in pua_cmap]
        if use_pua:
            _subset_woff2(pua_font, use_pua, os.path.join(fonts_dir, "kai-pua.woff2"))
            rest = [ch for ch in rest if ord(ch) not in pua_cmap]
    if rest:
        print("UNCOVERED kai fallback:", "".join(rest))


def build_fonts():
    charset = font_charset()
    print("font charset:", len(charset), "chars")
    fonts_dir = os.path.join(ROOT, "fonts")
    os.makedirs(fonts_dir, exist_ok=True)
    specs = [
        ("GJ-Kai-Regular.ttf", "kai-regular.woff2"),
        ("GJ-Kai-Bold.ttf", "kai-bold.woff2"),
        ("GJ-Song-Regular.ttf", "song-regular.woff2"),
        ("GJ-Song-Bold.ttf", "song-bold.woff2"),
        ("GJ-Title-Regular.ttf", "title-regular.woff2"),
        ("GJ-Title-Bold.ttf", "title-bold.woff2"),
    ]
    for src, dst in specs:
        sp = os.path.join(FONT_BUILD, src)
        if not os.path.exists(sp):
            print("MISSING FONT", sp)
            continue
        subset_font(sp, os.path.join(fonts_dir, dst), charset)

    build_kai_fallback(fonts_dir)

    face = """/* Web fonts subset from the EPUB build (OFL fonts + user-supplied Fangzheng / Cooper).
   Fangzheng Kai fonts are for personal, non-commercial use only.
   Do not publish this file together with the Fangzheng WOFF2s. */
@font-face { font-family: "GJ-Kai";  src: url("kai-regular.woff2") format("woff2");  font-weight: 400; font-style: normal; font-display: swap; }
@font-face { font-family: "GJ-Kai";  src: url("kai-bold.woff2")    format("woff2");  font-weight: 700; font-style: normal; font-display: swap; }
@font-face { font-family: "GJ-KaiFallback"; src: url("kai-fallback.woff2") format("woff2"); font-weight: 400; font-style: normal; font-display: swap; }
@font-face { font-family: "GJ-KaiExtB"; src: url("kai-extb.woff2") format("woff2"); font-weight: 400; font-style: normal; font-display: swap; }
@font-face { font-family: "GJ-KaiPua"; src: url("kai-pua.woff2") format("woff2"); font-weight: 400; font-style: normal; font-display: swap; }
@font-face { font-family: "GJ-Song"; src: url("song-regular.woff2") format("woff2"); font-weight: 400; font-style: normal; font-display: swap; }
@font-face { font-family: "GJ-Song"; src: url("song-bold.woff2")    format("woff2"); font-weight: 700; font-style: normal; font-display: swap; }
@font-face { font-family: "GJ-Title";src: url("title-regular.woff2")format("woff2"); font-weight: 400; font-style: normal; font-display: swap; }
@font-face { font-family: "GJ-Title";src: url("title-bold.woff2")   format("woff2"); font-weight: 700; font-style: normal; font-display: swap; }
"""
    with open(os.path.join(fonts_dir, "fonts.css"), "w", encoding="utf-8") as f:
        f.write(face)

    lic_dir = os.path.join(fonts_dir, "licenses")
    os.makedirs(lic_dir, exist_ok=True)
    for name in [
        "OFL-1.1-LXGWWenKai.txt",
        "OFL-1.1-SweiSugar.txt",
        "OFL-1.1-CooperZhengKai.txt",
        "OFL-1.1-NotoSerifCJK.txt",
        "OFL-1.1-NotoSansCJK.txt",
        "NOTICE-Fangzheng-ODZK.txt",
        "SOURCES.txt",
    ]:
        src = os.path.join(LICENSE_SRC, name)
        if os.path.exists(src):
            shutil.copyfile(src, os.path.join(lic_dir, name))


if __name__ == "__main__":
    os.makedirs(os.path.join(ROOT, "content"), exist_ok=True)
    build_original()
    build_marks()
    build_fonts()
    print("done")
