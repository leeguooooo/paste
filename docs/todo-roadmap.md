# TODO Roadmap

## P0 - 基础落地（本周）

- [ ] 初始化 Cloudflare 资源
- [ ] 建立 `apps/api` + `apps/web` + `packages/shared` 工作区
- [x] 建立 `/v1/health`、`/v1/clips` 基础接口
- [x] 设计 D1 初版 schema（支持同步与冲突处理字段）
- [x] 打通本地开发命令（Worker + Pages）
- [x] API 冒烟自动化测试（搜索/标签/收藏/同步/冲突）
- [ ] 部署 dev 环境并完成最小联调

## P1 - MVP（2~3 周）

- [ ] 鉴权（Email OTP 或第三方登录）
- [x] 剪贴板条目新增、列表、删除、收藏（后端）
- [x] 标签与快速筛选（后端）
- [x] 搜索（标题/内容关键字，后端）
- [ ] Web PWA 可安装（manifest + service worker）
- [ ] 最近条目离线读取

## P2 - 对标 Paste 核心体验

- [x] 多设备同步（增量 pull/push + 游标，后端）
- [x] 冲突解决策略（默认最后写入优先，后端）
- [ ] 快捷操作（最近使用、固定项目）
- [x] 结构化内容支持（文本、链接、HTML、图片基础能力，后端+macOS）
- [ ] 性能优化（KV 热缓存已接入，分页/索引持续优化）

## P3 - iOS 接入准备

- [ ] API 稳定化（版本约束、错误码统一）
- [ ] Token 生命周期与设备绑定策略
- [ ] iOS SDK/Client 接口文档
- [ ] 推送/后台同步策略评估

## 协作分工建议

- 你（主导）：产品定义、后端/数据层、协议与发布
- Gemini：Web 前端交互与视觉实现（按 `packages/shared` 契约开发）
- 我（Codex）：工程骨架、后端 API、数据库迁移、CI/发布脚本


## P4 - macOS App（新）

- [x] macOS 桌面端工程骨架（Electron + React）
- [x] 全局快捷键（Cmd/Ctrl + Shift + V）
- [x] 剪贴板监听自动入库（可开关）
- [x] 托盘菜单（显示/隐藏、手动抓取、退出）
- [ ] Quick Paste 面板与键盘导航
- [ ] Snippets/Pin/最近使用
- [ ] 开机自启与后台驻留策略
