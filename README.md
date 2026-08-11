# 刷题（多端刷题工具）

与「织题」联动的多端刷题应用：iPhone / iPad / 电脑浏览器均可使用，数据经 iCloud Drive 的 JSON 文件同步。

## 使用流程

1. **Mac 织题**：「PDF导入」页把真题 PDF 转成刷题 JSON（含题干/选项/答案/解析）。
2. **同步**：把生成的 JSON 放进 iCloud Drive（建议 `三端同步/刷题/`）。
3. **手机**：打开本应用 → 「导入数据」选择 iCloud 里的 JSON → 开始刷题（选择题自动判对错，大题手动标记，每题可写心得、可星标收藏）。
4. **回织题**：手机端「导出数据」存到 iCloud Drive → Mac 织题「刷题导入」页选择该 JSON → 只导入被星标收藏的题，做错的自动标「重点待解决」。

## 云同步（全自动）

1. 部署 `sync-worker/`（Cloudflare Workers + KV，步骤见该目录 README），得到网址与口令。
2. 刷题应用顶栏「云同步」→ 填网址与口令 → 开启。
3. 之后：打开自动拉取、有改动自动推送，多台设备打开即最新；冲突按每条记录的 `updatedAt` 保留新。
4. iCloud 手动导入导出保留为离线兜底（离线单文件版不受云同步影响）。

## 数据

- 全部数据存在浏览器 localStorage（每台设备一份）。
- 导入/导出都是同一个 JSON：`papers`（套卷与题目）+ `records`（每题的 对/错、收藏、心得）。
- 多台设备：用同一份 JSON 互相导入导出即可；记录按 `updatedAt` 保留较新者，题库以文件为准。

## 本地预览

```bash
cd /Users/Zhuanz1/Desktop/dev/刷题
python3 -m http.server 8090
# 浏览器打开 http://127.0.0.1:8090
```

## 部署到 GitHub Pages（公网可用）

```bash
cd /Users/Zhuanz1/Desktop/dev/刷题
git init && git add -A && git commit -m "刷题"
gh repo create zhiti-shuati --public --source=. --push
# 然后到仓库 Settings → Pages → 选 main 分支 / (root) 发布
```

如果国内访问 GitHub Pages 慢，用「离线版」兜底：

```bash
python3 build_offline.py   # 生成 dist/刷题-离线版.html
# 把该单文件放进 iCloud Drive（三端同步/刷题/），手机用「文件」App 打开即可离线做题
```

网址：
https://miaoartist.github.io/zhiti-shuati/
