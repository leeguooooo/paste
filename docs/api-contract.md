# API Contract (No Auth Phase)

基地址：`/v1`
公共请求头（除 `/health` 外都需要）：

- `x-user-id: <string>`
- `x-device-id: <string>`

## 1. 健康检查

- `GET /v1/health`

## 2. 剪贴板

- `GET /v1/clips`
  - Query:
    - `q` 关键字搜索（`summary`/`content`/`contentHtml`/`sourceUrl`）
    - `tag` 标签名过滤
    - `favorite=1` 仅收藏
    - `includeDeleted=1` 包含软删除
    - `cursor` 分页游标
    - `limit` 默认 50，最大 200
    - `lite=1` 轻量模式（列表不返回大字段 `contentHtml`/`imageDataUrl`，需要时用 `GET /v1/clips/:id` 取详情）
- `POST /v1/clips`
  - Body:
    - `id?: string`
    - `type?: "text" | "link" | "code" | "html" | "image"`
    - `summary?: string`
    - `content?: string`
    - `contentHtml?: string | null`
    - `sourceUrl?: string | null`（仅接受 `http/https`）
    - `imageDataUrl?: string | null`（当前 D1 存储模式限制约 1_500_000 字符）
    - `isFavorite?: boolean`
    - `isDeleted?: boolean`
    - `tags?: string[]`
    - `clientUpdatedAt?: number`
- `PATCH /v1/clips/:id`
  - Body: 同 `POST /v1/clips`（可部分更新）
- `GET /v1/clips/:id`
  - Response: `ClipItem`（包含 `contentHtml`/`imageDataUrl` 等详情字段）
- `DELETE /v1/clips/:id`
  - Body(可选):
    - `clientUpdatedAt?: number`

## 3. 标签

- `GET /v1/tags`
- `POST /v1/tags`
  - Body:
    - `name: string`
- `DELETE /v1/tags/:id`

## 4. 多设备同步

- `GET /v1/sync/pull`
  - Query:
    - `since` 默认 `0`
    - `limit` 默认 100，最大 300
    - `lite=1` 轻量模式（同上，不返回 `contentHtml`/`imageDataUrl`）
  - Response:
    - `changes: ClipItem[]`
    - `nextSince: number`
    - `hasMore: boolean`
- `POST /v1/sync/push`
  - Body:
    - `changes: Change[]`
  - `Change` 字段与 clip patch 一致，但 `id` 必填
  - Response:
    - `applied: ClipItem[]`
    - `conflicts: ClipItem[]`
    - `serverTime: number`

## 5. 冲突策略

- 采用 LWW（Last Write Wins）
- 比较字段：`clientUpdatedAt`
- 若传入变更比服务端旧：进入 `conflicts`
- 若更新不冲突：进入 `applied`

## 6. 读取性能策略（当前）

- `GET /v1/clips` 在“默认第一页查询”场景走可选 KV 热缓存：
  - 条件：无 `q/tag/favorite/includeDeleted/cursor` 且 `limit=50`
  - 过期：20 秒 TTL
- 写操作（create/patch/delete/sync push applied）后会失效该用户缓存
- 若未绑定 KV，接口仍正常运行（仅使用 D1）
