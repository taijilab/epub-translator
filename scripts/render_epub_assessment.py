"""Render a saved assessment as a local, linked evidence report."""

import html
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1] / "artifacts"
report = json.loads((root / "scaling-curve-quality-assessment.json").read_text(encoding="utf-8"))
escape = html.escape
sections = []
for finding in report["findings"]:
    references = " ".join(f'<a href="scaling-curve-review.html#p{number}">段落 #{number}</a>'
                          for number in finding["paragraph_ids"])
    sections.append(f'<section><h2>{escape(finding["severity"])} | {escape(finding["kind"])} | '
                    f'{escape(finding["page"])}</h2><p>{escape(finding["issue"])}</p>'
                    f'<div class="pair"><p><b>原文</b><br>{escape(finding["source_excerpt"])}</p>'
                    f'<p><b>实际结果</b><br>{escape(finding["translation_excerpt"])}</p></div>'
                    f'<p><b>建议</b> {escape(finding["suggestion"])}</p><p>{references}</p></section>')
strengths = "".join(f'<li>{escape(text)}</li>' for text in report["semantic_review"]["strengths"])
priorities = "".join(f'<li>{escape(text)}</li>' for text in report["priorities"])
files = " | ".join(f'<a href="{escape(name)}">{escape(label)}</a>'
                   for label, name in report["artifacts"].items())
page = '''<!doctype html><html lang="zh"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>前50页翻译质量评估</title>
<style>body{margin:32px auto;max-width:1000px;padding:0 20px;color:#202020;background:#fff;font:16px/1.8 system-ui}h1{font-size:26px}h2{font-size:19px}a{color:#166754}section{border-top:1px solid #ddd;padding:16px 0}.pair{display:grid;grid-template-columns:1fr 1fr;gap:24px;background:#f3f5f5;padding:12px}p{overflow-wrap:anywhere}li{margin:8px 0}@media(max-width:700px){.pair{grid-template-columns:1fr}}</style>'''
page += f'<h1>{escape(report["title"])}</h1><p>{escape(report["scope"])}</p>'
page += '<p>模型 deepseek-flash · 标准模式 · 并发 3 · 耗时 4分42秒 · 页面预估费用 ¥0.3777（非账单核验）</p>'
page += f'<h2>结论</h2><p>{escape(report["semantic_review"]["verdict"])}</p>'
page += '<p>202 个段落保持对应，无正文文件或段落缺失，id/href/src 无变化，无占位符泄漏。24 个完整段落保留英文，共 11,526 / 68,250 个原文非空白字符（约16.9%，不是准确率）。</p>'
page += '<h2>评估口径</h2><p>所有段落进行结构和原文保留检查；定向细读60段，其中最后一段原文在页界处截断，不纳入完整段落结论。另核验8处数字格式候选，未发现这些候选发生实际数值变化。未逐句认证全部成功译文。</p>'
page += f'<p>{escape(report["semantic_review"]["partial_boundary"])}</p>'
page += '<p>34个原始组，日志推算约160次请求尝试（112次组调用加48次额外重试），39次拆组。此值不是服务端请求审计，也不等于修复后的加速倍数。</p>'
page += f'<h2>表现较好</h2><ul>{strengths}</ul><h2>问题与证据</h2>' + "".join(sections)
page += f'<h2>建议顺序</h2><ol>{priorities}</ol><h2>原始材料</h2><p>{files}</p></html>'
(root / "scaling-curve-quality-assessment.html").write_text(page, encoding="utf-8")
print(root / "scaling-curve-quality-assessment.html")
