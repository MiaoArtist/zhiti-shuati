"""把刷题应用打包成单文件 HTML，供放进 iCloud Drive 离线使用。

用法：python3 build_offline.py
输出：dist/刷题-离线版.html
"""
import pathlib

root = pathlib.Path(__file__).parent
html = (root / "index.html").read_text(encoding="utf-8")
css = (root / "style.css").read_text(encoding="utf-8")
js = (root / "app.js").read_text(encoding="utf-8")

html = html.replace('<link rel="stylesheet" href="style.css?v=6">', "<style>" + css + "</style>")
html = html.replace('<script src="app.js?v=6"></script>', "<script>" + js + "</script>")

out = root / "dist" / "刷题-离线版.html"
out.parent.mkdir(exist_ok=True)
out.write_text(html, encoding="utf-8")
print(f"已生成: {out}  ({out.stat().st_size // 1024} KB)")
