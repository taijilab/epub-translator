"""Extract an EPUB sample using its publisher-supplied page-list."""

import argparse
import hashlib
import json
import posixpath
import re
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

XHTML = "http://www.w3.org/1999/xhtml"
EPUB = "http://www.idpf.org/2007/ops"
OPF = "http://www.idpf.org/2007/opf"
NCX = "http://www.daisy.org/z3986/2005/ncx/"
ET.register_namespace("epub", EPUB)
ET.register_namespace("dc", "http://purl.org/dc/elements/1.1/")


def local(element):
    return element.tag.rsplit("}", 1)[-1]


def serialize(element, namespace):
    ET.register_namespace("", namespace)
    return ET.tostring(element, encoding="utf-8", xml_declaration=True)


def trim_before(element, anchor):
    """Retain everything before an anchor, including a partial paragraph."""
    children = list(element)
    for index, child in enumerate(children):
        if child.get("id") == anchor:
            for following in children[index:]:
                element.remove(following)
            element.tail = None
            return True
        if trim_before(child, anchor):
            child.tail = None
            for following in children[index + 1:]:
                element.remove(following)
            element.tail = None
            return True
    return False


def extract(source, destination, last_page):
    with zipfile.ZipFile(source) as archive:
        container = ET.fromstring(archive.read("META-INF/container.xml"))
        opf_path = next(el for el in container.iter() if local(el) == "rootfile").get("full-path")
        base = posixpath.dirname(opf_path)
        package = ET.fromstring(archive.read(opf_path))
        manifest = package.find(f"{{{OPF}}}manifest")
        spine = package.find(f"{{{OPF}}}spine")
        items = {el.get("id"): el for el in manifest}
        nav_item = next(el for el in manifest if "nav" in el.get("properties", "").split())
        nav_path = posixpath.join(base, nav_item.get("href"))
        nav = ET.fromstring(archive.read(nav_path))
        page_list = next(el for el in nav.iter() if "page-list" in el.get(f"{{{EPUB}}}type", "").split())
        pages = {}
        for link in page_list.iter(f"{{{XHTML}}}a"):
            label = "".join(link.itertext()).strip()
            if label.isdigit():
                pages[int(label)] = link.get("href")
        if 1 not in pages or last_page not in pages or last_page + 1 not in pages:
            raise ValueError("The requested page boundaries are missing from the page-list")
        cutoff_file, separator, cutoff_anchor = pages[last_page + 1].partition("#")
        ordered = [items[el.get("idref")].get("href") for el in spine]
        cutoff_index = ordered.index(cutoff_file)
        selected = ordered[:cutoff_index + (1 if separator else 0)]
        documents = {href: ET.fromstring(archive.read(posixpath.join(base, href))) for href in selected}
        if separator and not trim_before(documents[cutoff_file].find(f"{{{XHTML}}}body"), cutoff_anchor):
            raise ValueError(f"Missing cutoff anchor: {cutoff_anchor}")

        valid_refs = set(selected)
        for href, doc in documents.items():
            valid_refs.update(href + "#" + el.get("id") for el in doc.iter() if el.get("id"))

        def prune_links(parent):
            for child in list(parent):
                prune_links(child)
                links = list(child.iter(f"{{{XHTML}}}a"))
                if local(child) == "li" and links and all(link.get("href") not in valid_refs for link in links):
                    parent.remove(child)

        prune_links(nav)
        excluded = set(ordered) - set(selected)
        for item in list(manifest):
            if item.get("href") in excluded:
                manifest.remove(item)
        for itemref in list(spine):
            if items[itemref.get("idref")].get("href") not in selected:
                spine.remove(itemref)
        guide = package.find(f"{{{OPF}}}guide")
        if guide is not None:
            for reference in list(guide):
                if reference.get("href") not in valid_refs:
                    guide.remove(reference)

        replacements = {opf_path: serialize(package, OPF), nav_path: serialize(nav, XHTML)}
        replacements.update({posixpath.join(base, href): serialize(doc, XHTML) for href, doc in documents.items()})
        for item in manifest:
            if item.get("media-type") == "application/x-dtbncx+xml":
                ncx_path = posixpath.join(base, item.get("href"))
                ncx = ET.fromstring(archive.read(ncx_path))
                for parent in ncx.iter():
                    for child in list(parent):
                        if local(child) in ("navPoint", "pageTarget"):
                            content = child.find(f"{{{NCX}}}content")
                            if content is not None and content.get("src") not in valid_refs:
                                parent.remove(child)
                replacements[ncx_path] = serialize(ncx, NCX)

        paragraphs = []
        for href, doc in documents.items():
            file_pages = {ref: page for page, ref in pages.items() if ref.partition("#")[0] == href}
            page = file_pages.get(href, 1)
            for element in doc.find(f"{{{XHTML}}}body").iter():
                if element.get("id"):
                    page = file_pages.get(href + "#" + element.get("id"), page)
                if local(element) not in ("p", "h1", "h2", "h3", "h4", "li"):
                    continue
                text = "".join(element.itertext()).strip()
                if not text:
                    continue
                end_page = page
                for descendant in element.iter():
                    if descendant.get("id"):
                        end_page = file_pages.get(href + "#" + descendant.get("id"), end_page)
                paragraphs.append({"id": len(paragraphs) + 1, "file": href, "page_start": page,
                                   "page_end": end_page, "source": text})
        destination.parent.mkdir(parents=True, exist_ok=True)
        excluded_paths = {posixpath.join(base, href) for href in excluded}
        with zipfile.ZipFile(destination, "w") as output:
            output.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
            for entry in archive.infolist():
                if entry.filename == "mimetype" or entry.filename in excluded_paths:
                    continue
                output.writestr(entry.filename, replacements.get(entry.filename, archive.read(entry.filename)),
                                compress_type=zipfile.ZIP_DEFLATED)
    text = "\n".join(p["source"] for p in paragraphs)
    report = {"source": str(source), "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
              "sample": str(destination), "page_range": [1, last_page], "boundary_method": "original EPUB page-list",
              "cutoff": pages[last_page + 1], "last_paragraph_is_partial": bool(separator),
              "content_files": selected, "paragraph_count": len(paragraphs),
              "english_word_count": len(re.findall(r"\b[\w]+(?:['\u2019-][\w]+)*\b", text)),
              "non_whitespace_characters": len(re.sub(r"\s", "", text)), "paragraphs": paragraphs,
              "translation_status": "pending real API translation; no quality score assigned"}
    destination.with_suffix(".source.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "paragraphs"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--pages", type=int, default=50)
    args = parser.parse_args()
    extract(args.source, args.destination, args.pages)
