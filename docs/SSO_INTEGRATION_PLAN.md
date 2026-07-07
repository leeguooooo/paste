# Paste 接入统一 SSO 方案

> Program source of truth: `/Users/leo/github.com/cloudflare-sso/docs/UNIFIED_IDENTITY_PROGRAM_PLAN_2026Q1.md`

## 1. 当前状态（已确认）
- 当前 API 自己签发会话 token（HMAC）。
- 身份解析逻辑为：
  - 优先读取 session/bearer token
  - 无 token 时可回退 `x-user-id + x-device-id`（可配置关闭）
- 关键位置：
  - `apps/api/src/index.ts` 中 `readSession/readBearerSession/getIdentity`
  - `ALLOW_HEADER_IDENTITY` 控制 header 身份兜底

## 2. 目标状态
- `paste` 使用统一 SSO 作为唯一身份源。
- `paste` API 不再签发本地登录 token，不再接受 header-only 身份。
- `paste` 的付费能力通过 entitlement API 判断。

## 3. 分阶段计划

### Phase A（Hybrid，兼容期）
1. 新增 `resolvePrincipal()`：
   - 先验 SSO JWT
   - 再回退旧 paste token
2. 保留 `ALLOW_HEADER_IDENTITY=1` 仅用于开发/灰度环境。
3. 新增观测指标：
   - `auth_source=sso|legacy|header`

验收：
- 可统计三类来源请求占比。
- 现有客户端不受影响。

### Phase B（切流）
1. Web 端登录入口改为跳转 SSO。
2. 新登录用户仅走 SSO token。
3. 观察 7~14 天：
   - legacy token 使用率下降
   - header 身份使用率接近 0

验收：
- 新版本客户端不再依赖 paste 本地登录接口。

### Phase C（收口）
1. 生产设置 `ALLOW_HEADER_IDENTITY=0`。
2. 删除本地会话签发和校验逻辑。
3. 仅保留 JWT 验证和 principal 映射。
4. 接入 entitlement 校验中间件。

验收：
- header-only 请求返回 401。
- 全量鉴权路径仅为 SSO JWT。

## 4. 数据迁移要点
- 在 paste 用户域增加 `sso_user_id` 映射字段（或新建映射表）。
- 对历史数据建立一次性回填脚本：
  - 依据邮箱/GitHub identity 做主键对齐
  - 冲突记录写入审计表人工处理

## 5. 立即执行清单
- [x] P-01 增加 `resolvePrincipal()` 与 `AUTH_MODE=legacy|hybrid|sso`
- [ ] P-02 为身份来源打点
- [ ] P-03 Web 登录改造为 SSO
- [ ] P-04 生产禁用 header 身份兜底
- [ ] P-05 删除 legacy token 签发/校验逻辑

## 6. 最新进展（2026-02-26）
- `cloudflare-sso` 已新增 `tenant-misonote` 与客户端：
  - `misonote-app-web`
  - `misonote-paste-web`
  - `misonote-choose-browser-web`
  - `misonote-blog-web`
- `paste` API 配置已预置统一会员字段（后续代码接入直接启用）：
  - `AUTH_MODE=hybrid`
  - `SSO_ISSUER=https://cloudflare-sso.pages.dev`
  - `SSO_ENTITLEMENT_TENANT_ID=tenant-misonote`
  - `SSO_REQUIRED_ENTITLEMENT_KEY=membership.all_apps`
- `apps/api/src/index.ts` 已完成首轮鉴权切换：
  - `getIdentity()` 支持 `AUTH_MODE=legacy|hybrid|sso`
  - `hybrid/sso` 模式优先识别 Bearer JWT 并调用 SSO `/userinfo`
  - `sso` 模式下关闭 header 身份兜底
- Web 端已接入 OIDC PKCE 登录流程（前端发起 + API 代换 token）：
  - 新增接口：`POST /v1/auth/sso/token`
  - `apps/web/src/App.tsx` 登录按钮在 `hybrid/sso` 下优先走 SSO
