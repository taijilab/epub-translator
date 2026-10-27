"""Render recorded three-run evidence and a focused human review; no API calls."""

from collections import Counter
import html
import json
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1] / "artifacts"
load = lambda name: json.loads((root / name).read_text(encoding="utf-8"))
previous = load("scaling-curve-v3-v4-comparison.json")
current = load("scaling-curve-v5-review.json")
v4 = load("scaling-curve-v4-review.json")
evidence = load("scaling-curve-v5-run-evidence.json")
failures = load("scaling-curve-v5-failures.json")
stats = evidence["stats"]
normalize = lambda text: re.sub(r"\s", "", text)
unchanged = [pair for pair in current["pairs"] if normalize(pair["source"]) == normalize(pair["translated"]) and re.search(r"[A-Za-z]{4}", pair["source"])]
leaks = [pair["id"] for pair in current["pairs"] if "[[EPUB_TAG_" in pair["translated"]]
untranslated = [pair for pair in unchanged if pair["id"] != 13]
untranslated_share = sum(len(normalize(pair["source"])) for pair in untranslated) / sum(len(normalize(pair["source"])) for pair in current["pairs"])
duration = re.search(r"(?:(\d+)分)?(\d+)秒", stats["translationTime"])
new = {
    "duration_seconds": int(duration[1] or 0) * 60 + int(duration[2]),
    "input_tokens": int(stats["inputTokens"].replace(",", "")),
    "output_tokens": int(stats["outputTokens"].replace(",", "")),
    "total_tokens": int(stats["totalTokens"].replace(",", "")),
    "estimated_yuan": float(re.search(r"[\d.]+", stats["estimatedCost"])[0]),
    "request_attempts_in_log": sum("开始请求" in line for line in evidence["log"]),
    "repair_requests_in_log": sum("开始请求" in line and ".修复" in line for line in evidence["log"]),
    "cache_hits_in_log": sum(int(hit) for line in evidence["log"] for hit in re.findall(r"复用缓存 (\d+)", line)),
    "program_failures": len(failures["failures"]),
    "untranslated_paragraphs": len(untranslated),
    "untranslated_character_share": untranslated_share,
    "unchanged_author_name_excluded": [13],
    "placeholder_leak_ids": leaks,
    "warnings": len(failures["warnings"]),
    "warning_types": dict(Counter(item.get("code", "term") for item in failures["warnings"])),
    "structure_differences": current["structure_differences"],
    "file_issues": current["file_issues"],
    "confirmed_glossary_version": 0,
}
findings = [
    {"ids": [84,146,147], "status": "完整性改善", "detail": "上轮第84段因页码标签失败而保留原文，本轮已译出；OpenAI相关短段也正常译出。202段中没有整段正文退回英文。作者署名#13保留英文，不算漏译。"},
    {"ids": [79], "status": "新的交付阻断问题", "detail": "译文混入字面量[[EPUB_TAG_数字]]。这不是原书内容，也没有被程序的数字型占位符校验或20条审校警告捕获。XML有效并不代表内容正确。建议校验所有EPUB_TAG前缀，并只修复该段。"},
    {"ids": [12], "status": "语义回退", "detail": "上轮副标题正确表达生存；本轮把survive译成驾驭，改变原意。建议译为：打造超级智能并在其时代生存下来的竞赛。"},
    {"ids": [98], "status": "专业表达仍不准确", "detail": "本轮在数值上把它限制得很糟糕仍没有准确表达数值条件/病态性。建议人工核对为：不要做导致数值条件变差之类的蠢事。"},
    {"ids": [100,123], "status": "有改善，也有新偏差", "detail": "#100的sprawling已译出；#123把缩放到月球改为无限扩展，意图更清楚。但#100把vast data infrastructure译成庞大数据库，缩窄了数据基础设施的含义。"},
    {"ids": [4,5,6], "status": "断行对齐仍未解决", "detail": "未经作者书面许可仍从#6移到#4，#6只剩检索系统。连读尚可，逐段对齐不成立。新增否定检查捕获了#6，但不会自动修正。"},
    {"ids": [38,44,77,108,127,162,189,201], "status": "全名稳定，简称仍混用", "detail": "术语手册中Dario Amodei从上轮5种译名降为1种达里奥·阿莫代伊，但正文Dario仍保留英文34次，Clark也保留英文。没有人工确认术语，不能将这次稳定性归因于确认功能。"},
    {"ids": [105,121,123,127,168,177,202], "status": "概念一致性仍待统一", "detail": "Big Blob of Compute在本轮主要用大计算团块；scaling的候选包含规模化与缩放，正文另有扩展。不能把三词的全文总频次直接当成误译次数，需要按语境审校。"},
    {"ids": [53,83,201], "status": "排版和旧噪声改善", "detail": "旧版许<多、段首T、硏究在对应段落未再出现。202段中角引号和ASCII双引号均为0，53段有中文弯引号；仍有10段出现英文与中文之间的空格。单次重跑不证明噪声永不再现。"},
    {"ids": [36,40,53,77,84,153,164,174,175,177,196,201], "status": "数字警告需降噪", "detail": "12条数字候选主要来自英文月份译为数字、年代改写、中文数字及GPT编号重复等，不等于12个错误。#174/#177的175 billion→1750亿正确；#36漏了三百万房价的美元单位，是值得保留的实际候选。"},
    {"ids": [102,103,105,108,123], "status": "候选术语警告仍有误报", "detail": "7条术语候选中多条把Clark、Olah、Ray Kurzweil的英文保留形式当参考，却在后续中文正确音译时报警。应先归并全名与简称，冲突候选不成为约束。警告均未导致拒收或额外付费重译。"},
    {"ids": [202], "status": "样本边界排除", "detail": "第50页在句中结束，末段不完整来自取样边界，不算模型漏句，也不能要求补写第51页内容。"},
]
audited = [4,5,6,12,13,36,38,40,44,52,53,68,74,77,78,79,83,84,91,98,100,102,103,105,108,121,123,127,135,146,147,153,162,164,168,174,175,177,178,183,189,196,201,202]
report = {
    "versions": ["paragraphs-v3", "validated-v4", "quality-v5"],
    "configuration": evidence["configuration"],
    "same_source_paragraphs_verified": True,
    "paragraph_count": 202,
    "baseline": previous["baseline"], "v4": previous["new_run"], "v5": new,
    "audited_paragraph_ids": audited,
    "review_scope": "202段自动结构/残留检查，44段定向原译文审阅，不是202段逐句全面审校。",
    "findings": findings,
    "cost_caveat": "费用为程序预估，非账单。本轮处于程序定义的高峰计价时段，前轮非高峰，不宜直接比较金额。按相同非高峰费率粗算本轮约0.1664元。",
    "quality_caveat": "同一模型单次重跑，有随机性；自动候选数不可直接用作质量分数。人工确认术语版本0，尚未检验确认译名的效果。",
    "next_priority": ["广义占位符泄漏拦截及缓存复查", "确认核心全名、简称、概念译名", "数字和术语候选降噪", "定向审校副标题、数值条件、版权页断行"],
}
target = root / "scaling-curve-v3-v4-v5-comparison.json"
target.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
escape = html.escape
rows = []
for label, key, formatter in [
    ("未译正文段落", "untranslated_paragraphs", str),
    ("未译原文字量", "untranslated_character_share", lambda value: f"{value*100:.2f}%"),
    ("耗时", "duration_seconds", lambda value: f"{value}秒"),
    ("请求尝试", "request_attempts_in_log", str),
    ("总Token", "total_tokens", lambda value: f"{value:,}"),
    ("程序预估费用 / 非账单", "estimated_yuan", lambda value: f"¥{value:.4f}"),
]:
    rows.append("<tr><th>" + label + "</th>" + "".join(f"<td>{formatter(run[key])}</td>" for run in [previous["baseline"], previous["new_run"], new]) + "</tr>")
sections = []
for finding in findings:
    links = " ".join(f'<a href="scaling-curve-v5-review.html#p{number}">#{number}</a>' for number in finding["ids"])
    sections.append(f'<section><h2>{escape(finding["status"])}</h2><p>{escape(finding["detail"])}</p><p>{links}</p></section>')
comparisons = []
for number in [12,79,84,98,100,123]:
    pair = next(p for p in current["pairs"] if p["id"] == number)
    old = next(p for p in v4["pairs"] if p["id"] == number)
    comparisons.append(f'<section><h2>重点原译文 #{number}</h2><div class="pairs"><div><h3>原文</h3><p>{escape(pair["source"])}</p></div><div><h3>v4</h3><p>{escape(old["translated"])}</p></div><div><h3>v5</h3><p>{escape(pair["translated"])}</p></div></div></section>')
page = '''<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>50页翻译样本：v3 / v4 / v5 对比</title><style>
body{max-width:1180px;margin:32px auto;padding:0 20px;font:16px/1.8 system-ui;color:#202020;background:#fff}
h1{font-size:26px}h2{font-size:19px}h3{font-size:16px}table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{border-bottom:1px solid #ddd;padding:10px;text-align:left}section{border-top:1px solid #ddd;padding:12px 0}
a{color:#166754}p{overflow-wrap:anywhere}.table{overflow:auto}.pairs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px}
@media(max-width:800px){.pairs{grid-template-columns:1fr}h1{font-size:23px}th,td{padding:8px}}</style>
<h1>The Scaling Curve：前50页三轮翻译对比</h1>
<p>结论：整段漏译已消除，排版更统一；专业语义、简称一致性仍需审校，且出现了一个未被程序捕获的占位符泄漏。暂不宜直接交付。</p>
<p>同一202段原文；TaoToken / deepseek-flash / 标准 / 并发3 / 冷缓存。本轮人工确认术语为0条。202段自动检查，44段定向审阅，不是全文逐句审校。</p>
<div class="table"><table><thead><tr><th>指标</th><th>v3</th><th>v4</th><th>v5</th></tr></thead><tbody>'''
page += "".join(rows) + '</tbody></table></div><p>' + escape(report["cost_caveat"]) + '</p><p>本轮0个程序失败，20条候选：12条数字、7条术语、1条否定。候选数量不是实际错误数，也不与旧版警告数直接比较。</p>'
page += "".join(sections) + "".join(comparisons) + '<p><a href="scaling-curve-v5-review.html">完整202段原译文对照</a> · <a href="scaling-curve-v3-v4-v5-comparison.json">结构化报告</a></p></html>'
target.with_suffix(".html").write_text(page, encoding="utf-8")
print(json.dumps(new, ensure_ascii=False, indent=2))
