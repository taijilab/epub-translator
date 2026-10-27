"""Build a source/translation review file, without assigning machine quality scores."""

import argparse
from collections import Counter
import html
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET
import zipfile


def paragraphs(document):
    root = ET.fromstring(document)
    body = next(el for el in root.iter() if el.tag.rsplit("}", 1)[-1] == "body")
    return [(el, "".join(el.itertext()).strip()) for el in body.iter()
            if el.tag.rsplit("}", 1)[-1] in ("p", "h1", "h2", "h3", "h4", "li")
            and "".join(el.itertext()).strip()]


def compare(source_json, translated, destination):
    source = json.loads(source_json.read_text(encoding="utf-8"))
    offsets = Counter()
    pairs = []
    issues = []
    structure = []
    with zipfile.ZipFile(translated) as target, zipfile.ZipFile(source["sample"]) as original:
        translated_paragraphs = {}
        for name in source["content_files"]:
            path = "OEBPS/" + name
            if path not in target.namelist():
                issues.append({"file": name, "type": "missing_file"})
                translated_paragraphs[name] = []
                continue
            try:
                translated_paragraphs[name] = paragraphs(target.read(path))
                source_elements = list(ET.fromstring(original.read(path)).iter())
                target_elements = list(ET.fromstring(target.read(path)).iter())
                for attribute in ("id", "href", "src"):
                    before = Counter(el.get(attribute) for el in source_elements if el.get(attribute))
                    after = Counter(el.get(attribute) for el in target_elements if el.get(attribute))
                    if before != after:
                        structure.append({"file": name, "attribute": attribute,
                                          "removed": list((before - after).elements()),
                                          "added": list((after - before).elements())})
            except ET.ParseError as error:
                issues.append({"file": name, "type": "invalid_xml", "detail": str(error)})
                translated_paragraphs[name] = []
        for entry in source["paragraphs"]:
            name = entry["file"]
            index = offsets[name]
            offsets[name] += 1
            candidates = translated_paragraphs[name]
            text = candidates[index][1] if index < len(candidates) else ""
            flags = []
            if not text:
                flags.append("empty_or_missing_translation")
            elif text == entry["source"] and re.search(r"[A-Za-z]{4}", text):
                flags.append("unchanged_english_review_required")
            if "[[EPUB_TAG_" in text:
                flags.append("placeholder_leak")
            numbers = lambda value: Counter(re.findall(r"\d+(?:[.,]\d+)*", value))
            if numbers(entry["source"]) != numbers(text):
                flags.append("numeric_notation_changed_review_required")
            pairs.append({**entry, "translated": text, "review_flags": flags})
        for name, values in translated_paragraphs.items():
            if len(values) != offsets[name]:
                issues.append({"file": name, "type": "paragraph_count_mismatch",
                               "source": offsets[name], "translated": len(values)})
    report = {"translated_epub": str(translated), "source_sample": source["sample"],
              "page_range": source["page_range"], "paragraph_count": len(pairs),
              "alignment": "file + nonempty paragraph ordinal; reliable only when paragraph counts match",
              "structure_differences": structure, "file_issues": issues,
              "flags_are_review_candidates_not_confirmed_errors": True,
              "flag_counts": dict(Counter(flag for pair in pairs for flag in pair["review_flags"])),
              "pairs": pairs}
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    rows = []
    for pair in pairs:
        label = f"#{pair['id']} | pp. {pair['page_start']}-{pair['page_end']} | {pair['file']}"
        rows.append(f"<section id='p{pair['id']}'><h2>{html.escape(label)}</h2>"
                    f"<div class='pair'><p lang='en'>{html.escape(pair['source'])}</p>"
                    f"<p lang='zh'>{html.escape(pair['translated'])}</p></div></section>")
    page = """<!doctype html><html lang="zh"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Scaling Curve | Translation Review</title>
<style>body{margin:24px auto;max-width:1200px;padding:0 16px;font:16px/1.8 system-ui;color:#181818;background:#fff}
h1{font-size:24px}h2{font-size:14px;color:#555}section{border-top:1px solid #ddd;padding:12px 0}.pair{display:grid;grid-template-columns:1fr 1fr;gap:32px}p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:700px){.pair{grid-template-columns:1fr;gap:16px}}</style>
<h1>The Scaling Curve | 第 1–50 页原译文对照</h1>""" + "".join(rows) + "</html>"
    destination.with_suffix(".html").write_text(page, encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "pairs"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_json", type=Path)
    parser.add_argument("translated", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    compare(args.source_json, args.translated, args.destination)
