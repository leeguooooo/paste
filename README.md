# paste-lite

一个基于 Cloudflare 的 Paste 替代方案，目标是：

- 免费可用（Workers + Pages + R2 + D1 + KV）
- Web 优先，同时支持“可安装应用”（PWA）
- 后续新增 iOS 客户端（复用同一套 API 与数据模型）
- 核心功能对标 Paste（剪贴板历史、搜索、收藏、同步、分类）

## 仓库结构

```txt
apps/
  api/          # Cloudflare Worker API
  web/          # Cloudflare Pages 前端（占位，前端将由 Gemini 承接）
packages/
  shared/       # 跨端共享类型/协议
docs/
  architecture.md
  todo-roadmap.md
```

## 技术选型（当前实现）

- Runtime: Cloudflare Workers
- Frontend Hosting: Cloudflare Pages
- Shared Contract: TypeScript workspace package
- Data Plane:
  - D1: 条目、标签、同步时间戳（已接入）
  - R2: 大文本/附件（下一阶段）
  - KV: 热缓存与热点查询（下一阶段）

## 本地开发

先创建 D1（只需要一次）：

```bash
cd apps/api
wrangler d1 create paste-db
# 把输出的 database_id 回填到 apps/api/wrangler.toml
wrangler d1 migrations apply paste-db --local
cd ../..
```

可选：启用 KV 热缓存（推荐）：

```toml
# apps/api/wrangler.toml
[[kv_namespaces]]
binding = "CACHE"
id = "<your-kv-namespace-id>"
```

然后启动开发环境：

```bash
npm install
npm run dev:api
npm run dev:web
```

运行 API 自动化冒烟测试：

```bash
npm run test:api:smoke
```

## 当前核心 API（无登录版）

无登录阶段通过请求头标识用户和设备：

- `x-user-id: your-user-id`
- `x-device-id: your-device-id`

已实现接口：

- `GET /v1/health`
- `GET /v1/clips`（支持 `q`、`tag`、`favorite`、`cursor`、`limit`）
- `POST /v1/clips`
- `PATCH /v1/clips/:id`
- `DELETE /v1/clips/:id`（软删除）
- `GET /v1/tags`
- `POST /v1/tags`
- `DELETE /v1/tags/:id`
- `GET /v1/sync/pull?since=...&limit=...`
- `POST /v1/sync/push`（LWW 冲突策略）

性能说明：

- 默认第一页列表查询（`GET /v1/clips?limit=50` 且无筛选）支持可选 KV 热缓存。
- 未配置 KV 也可正常运行，仅回退 D1。

示例：

```bash
curl -X POST http://127.0.0.1:8787/v1/clips \
  -H 'content-type: application/json' \
  -H 'x-user-id: u_demo' \
  -H 'x-device-id: mac_01' \
  -d '{
    "type":"text",
    "content":"hello paste-lite",
    "tags":["work","snippet"],
    "isFavorite":true
  }'
```

## 部署

```bash
npm run deploy:api
npm run deploy:web
```

## 文档

- 架构设计: `docs/architecture.md`
- 分阶段 TODO: `docs/todo-roadmap.md`
- API 契约: `docs/api-contract.md`
- 前端对接: `docs/frontend-handoff.md`
