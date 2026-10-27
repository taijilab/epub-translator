"""Compare recorded EPUB runs and render their evidence without calling a model."""

from collections import Counter
import html
import json
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1] / "artifacts"
load = lambda name: json.loads((root / name).read_text(encoding="utf-8"))
old = load("scaling-curve-quality-assessment.json")
old_pairs = load("scaling-curve-review.json")
new_pairs = load("scaling-curve-v4-review.json")
failures = load("scaling-curve-v4-failures.json")
warning_review = load("scaling-curve-v4-warning-recheck.json")
summary = (root / "scaling-curve-v4-run-summary.txt").read_text(encoding="utf-8")
log = (root / "scaling-curve-v4-run.log").read_text(encoding="utf-8")


def field(label):
    return summary.split(label + "\n", 1)[1].split("\n", 1)[0].replace(",", "")


def normalize(text):
    return re.sub(r"\s", "", re.sub(r"\[\[EPUB_TAG_\d+\]\]", "", text))


seconds = re.search(r"(?:(\d+)分)?(\d+)秒", field("翻译时长:"))
duration = int(seconds[1] or 0) * 60 + int(seconds[2])
total = sum(len(normalize(pair["source"])) for pair in new_pairs["pairs"])
failed_originals = {normalize(entry["original"]) for entry in failures["failures"]}
untranslated = [pair for pair in new_pairs["pairs"] if normalize(pair["source"]) in failed_originals
                and normalize(pair["translated"]) == normalize(pair["source"])]
new_run = {
    "duration_seconds": duration,
    "input_tokens": int(field("输入 Token")), "output_tokens": int(field("输出 Token")),
    "total_tokens": int(field("总 Token")),
    "estimated_yuan": float(re.search(r"[\d.]+", field("预估费用:"))[0]),
    "root_groups": 34, "request_attempts_in_log": log.count("开始请求"),
    "additional_repair_requests": sum("开始请求" in line and ".修复" in line for line in log.splitlines()),
    "failures": len(failures["failures"]), "untranslated_paragraphs": len(untranslated),
    "untranslated_paragraph_ids": [pair["id"] for pair in untranslated],
    "untranslated_characters": sum(len(normalize(pair["source"])) for pair in untranslated),
    "original_characters": total,
    "raw_warnings": len(failures["warnings"]),
    "offline_remaining_warning_candidates": warning_review["pending_candidates"],
    "memory_cache_hits_reported": sum(int(value) for value in re.findall(r"复用缓存 (\d+)", log)),
    "source_structure_issues": new_pairs["file_issues"] + new_pairs["structure_differences"]
}
new_run["untranslated_character_share"] = new_run["untranslated_characters"] / total
baseline = {
    "duration_seconds": old["run"]["elapsed_seconds"],
    "total_tokens": old["run"]["total_tokens_displayed"],
    "request_attempts_in_log": old["run"]["estimated_request_attempts_from_log"],
    "estimated_yuan": old["run"]["estimated_yuan_displayed"],
    "untranslated_paragraphs": old["automatic_checks"]["unchanged_english_paragraphs"],
    "untranslated_character_share": old["automatic_checks"]["unchanged_source_nonwhitespace_characters"] / old["automatic_checks"]["source_nonwhitespace_characters"]
}
findings = [
    {"ids": [84], "status": "仍未完成", "detail": "462个原文非空白字符保留英文。页码空span占位符在三次尝试中均未完整返回；其余组内片段已保留成功结果。"},
    {"ids": [12,175], "status": "本次结果正确", "detail": "副标题中的survive不再译成存续超级智能；GPT-2/GPT-3的能力包含关系也恢复正确。重跑存在模型随机差异，不能把这两项归因于已经实现了语义审校。"},
    {"ids": [100], "status": "仍有残留英文", "detail": "research division已译为研究部门，但同一段又留下了sprawling。说明仅重跑不能保证消除句内漏译。"},
    {"ids": [98,123], "status": "专业表达仍需审校", "detail": "数值条件仍被含糊地译成在数值上把它搞得很糟糕；scale to the moon仍直译为缩放到月球。"},
    {"ids": [4,5,6], "status": "断行问题仍在", "detail": "未经作者书面许可仍从第6段移动到第4段。连续读时大意保留，但逐段语义对齐不成立，需要针对断行片段的翻译单元处理。"},
    {"ids": [53,83,201], "status": "输出噪声", "detail": "第53段出现许<多，第83段开头多出T，第201段硏究使用了异体字。这些没有破坏XML，但需要输出规则检查。"},
    {"ids": [38,44,77,201], "status": "人名一致性未解决", "detail": "手册中Dario Amodei有英文保留及阿莫代伊、阿莫迪、阿莫德伊、阿莫代等至少5种写法。禁用冲突候选能避免漏译，但不能代替人工确认标准译名。"},
    {"ids": [121,127], "status": "概念提取有所改善", "detail": "本次Big Blob of Compute进入了技术术语类别，译为算力大团块；仍需与其他大小写、短称写法做实体归并。"},
    {"ids": [202], "status": "取样边界，不计完整段落错误", "detail": "第50页在句中结束，译文保留了未完句。不能将其算作全书漏译，也不应要求模型编造第51页内容。"}
]
audited = [4,5,6,12,13,36,38,40,44,53,68,74,77,78,83,84,91,98,100,108,121,123,127,135,146,147,153,162,168,174,175,177,178,183,189,196,201,202]
variants = []
old_terms, new_terms = load("scaling-curve-terms.json"), load("scaling-curve-v4-terms.json")
for name in ["Dario Amodei", "Chris Olah", "Olah", "scaling", "compute", "Big Blob of Compute"]:
    variants.append({"source": name,
                     "old": sorted({term["target"] for term in old_terms["terms"] if term["source"] == name}),
                     "new": sorted({term["target"] for term in new_terms["terms"] if term["source"] == name})})
report = {"baseline_version": "paragraphs-v3", "run_version": failures["version"],
          "configuration": "同一50页样本；TaoToken deepseek-flash；标准；并发3；空人工术语表；日志缓存命中0。",
          "comparison_caveats": "单次重跑，非多轮统计实验；请求数来自日志，费用来自页面预估而非账单。",
          "baseline": baseline, "new_run": new_run, "findings": findings,
          "audited_paragraph_ids": audited, "terms_variants_observed": variants,
          "warning_recheck_caveat": "运行原始报告46条；仅离线复核边界匹配，38条不再命中警告，剩8条候选不是8个已确认错误。没有重译或修改译本。",
          "next_priority": "页码锚点定向格式修复、人工确认核心实体、句内英文与语义审校；不建议立即重译全书。"}
(root / "scaling-curve-v3-v4-comparison.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
escape = html.escape
rows = []
for label, key, formatter in [
    ("真正未译段落", "untranslated_paragraphs", lambda value: str(value)),
    ("未译原文字量", "untranslated_character_share", lambda value: f"{value * 100:.2f}%"),
    ("耗时", "duration_seconds", lambda value: f"{value // 60}分{value % 60:02d}秒"),
    ("请求尝试（日志）", "request_attempts_in_log", lambda value: str(value)),
    ("总Token（界面）", "total_tokens", lambda value: f"{value:,}"),
    ("预估费用（非账单）", "estimated_yuan", lambda value: f"¥{value:.4f}")]:
    rows.append(f"<tr><td>{label}</td><td>{formatter(baseline[key])}</td><td>{formatter(new_run[key])}</td></tr>")
sections = []
for finding in findings:
    links = " ".join(f'<a href="scaling-curve-v4-review.html#p{number}">#{number}</a>' for number in finding["ids"])
    sections.append(f'<section><h2>{escape(finding["status"])}</h2><p>{escape(finding["detail"])}</p><p>{links}</p></section>')
page = '''<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>50页样本：v3 / v4实测对比</title><style>body{max-width:1000px;margin:32px auto;padding:0 20px;font:16px/1.8 system-ui;color:#202020;background:#fff}h1{font-size:26px}h2{font-size:19px}table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{border-bottom:1px solid #ddd;padding:10px;text-align:left}a{color:#166754}section{border-top:1px solid #ddd;padding:12px 0}p{overflow-wrap:anywhere}</style>'''
page += f'<h1>50页样本：v3 / v4实测对比</h1><p>{escape(report["configuration"])}</p>'
page += '<h2>结论</h2><p>术语校验造成的未译已消除，效率和完整性明显改善。但仍有1个标签失败段落、人名多译法及句内漏译，尚不适合作为最终出版译本。</p>'
page += '<table><thead><tr><th>指标</th><th>旧版 v3</th><th>新版 v4</th></tr></thead><tbody>' + "".join(rows) + '</tbody></table>'
page += f'<p>{escape(report["comparison_caveats"])}</p><p>202段保持结构对应，id/href/src无变化；原样保留的作者姓名Claude St. John不算未译。34个原始组，额外修复请求5次，预算未耗尽。</p>'
page += '<h2>待审校报告复核</h2><p>原始46条警告中，多数因英文名紧贴中文触发边界误报。已修正该匹配功能，并对保存结果离线复核：38条误报解除，剩8条候选仍需检查。译本、付费运行日志和原始46条报告均未改写。</p>'
page += f'<h2>质量抽查</h2><p>定向核对{len(audited)}段，其中#202为页界未完句；全部202段做结构、原文保留和数字格式候选扫描，没有给整本书准确率评分。</p>' + "".join(sections)
page += f'<h2>下一步</h2><p>{escape(report["next_priority"])}</p>'
page += '<p><a href="scaling-curve-v4-review.html">新版逐段对照</a> | <a href="scaling-curve-review.html">旧版逐段对照</a> | <a href="scaling-curve-v4-translated.epub">新版EPUB</a> | <a href="scaling-curve-v4-failures.json">原始失败与警告</a> | <a href="scaling-curve-v4-warning-recheck.json">离线警告复核</a> | <a href="scaling-curve-v3-v4-comparison.json">对比数据</a></p></html>'
(root / "scaling-curve-v3-v4-comparison.html").write_text(page, encoding="utf-8")
print(json.dumps(new_run, ensure_ascii=False, indent=2))
