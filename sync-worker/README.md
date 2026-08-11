# 刷题云同步后端（Cloudflare Workers + KV）

实现 `GET/PUT /api/sync`，配合刷题应用的「云同步」设置使用。

## 部署步骤（一次性，免费）

```bash
cd /Users/Zhuanz1/Desktop/dev/刷题/sync-worker

# 1. 登录 Cloudflare（会打开浏览器）
npx wrangler login

# 2. 创建 KV 命名空间，把输出的 id 填进 wrangler.toml 的 [[kv_namespaces]] id
npx wrangler kv namespace create SYNC_KV

# 3. 在 wrangler.toml 的 [vars] 里设置 SYNC_TOKEN（自定义口令，如一个长随机串）

# 4. 部署
npx wrangler deploy
```

部署完成后会得到类似 `https://zhiti-sync.<你的子域>.workers.dev` 的地址。

## 在刷题应用里配置

1. 打开刷题应用 → 顶栏「云同步」。
2. 勾选开启，填同步地址（上一步的网址）和口令（SYNC_TOKEN），保存。
3. 打开应用自动拉取、有改动自动推送；多台设备填同一套配置即互通。

## 本地联调（可选）

在刷题目录跑一个本地 mock（模拟 worker 的接口）：
```bash
python3 /tmp/zhiti_test/mock_sync.py   # 监听 8091，token: test123
```
然后在应用的云同步设置里填 `http://127.0.0.1:8091` 和 `test123` 即可本地测试。
