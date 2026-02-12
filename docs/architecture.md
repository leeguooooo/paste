# 架构设计（Cloudflare 免费优先）

## 1. 目标与约束

- 目标：功能体验对标 Paste，Web 可用，可安装（PWA），后续扩展 iOS。
- 约束：优先使用 Cloudflare 免费层，控制早期成本。

## 2. 总体架构

```txt
Web(Pages/PWA)      iOS(App)
      |               |
      +------ HTTPS API (Workers) ------+
                     |                   |
                  D1 (metadata)       KV (cache/index)
                     |
                   R2 (payload/blob, next)
```

## 3. 职责拆分

- `apps/web`
  - 前端 UI、PWA 安装能力、离线读取最近内容
  - 与 `apps/api` 通信
- `apps/macos`
  - Electron 托盘应用（无主窗口常驻）
  - 剪贴板监听、手动抓取、快速搜索与复制
- `apps/api`
  - 条目 CRUD、搜索、标签、收藏、同步策略
  - 无登录阶段通过 `x-user-id`、`x-device-id` 标识身份
  - 与 D1/KV 交互
- `packages/shared`
  - API DTO、错误码、客户端协议版本

## 4. 核心数据模型（当前）

- `clips`
  - `id`, `user_id`, `device_id`, `type`, `summary`, `content`
  - `content_html`, `source_url`, `image_data_url`
  - `is_favorite`, `is_deleted`
  - `client_updated_at`, `server_updated_at`, `created_at`
- `tags`
  - `id`, `user_id`, `name`, `normalized_name`, `is_deleted`
- `clip_tags`
  - `user_id`, `clip_id`, `tag_id`

说明：
- 目前文本/HTML/链接/小图片（Data URL）直存 D1。
- 大附件后续迁移到 R2，D1 只保存索引与元数据。
- 常用列表（最近 50 条）可写入 KV 做读缓存。

## 5. API 分层

- `/v1/health`
- `/v1/auth/*`（后续）
- `/v1/clips`（列表、创建、编辑、删除、搜索、收藏）
- `/v1/tags`（管理）
- `/v1/sync/pull`、`/v1/sync/push`（跨端同步）

## 6. PWA 与“可安装应用”

- Pages 提供 Web + Manifest + Service Worker
- Chrome/Safari（部分能力）可“安装到桌面”
- 这不是原生 macOS app，但能实现“安装入口 + 快捷启动 + 本地缓存”

## 7. iOS 扩展策略

- iOS 客户端只消费同一套 `/v1/*` 接口
- `packages/shared` 保持协议稳定（版本化）
- 同步策略保持“增量 + 游标 + 冲突策略（最后写入优先/时间戳）”

## 8. 里程碑建议

- M1: 单用户本地可用（Web + Worker + D1 基础 CRUD）
- M2: 多设备同步与搜索优化
- M3: iOS 首版接入
