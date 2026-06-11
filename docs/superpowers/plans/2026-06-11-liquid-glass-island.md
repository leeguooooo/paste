# Liquid Glass 玻璃岛改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Pastyx macOS 主面板从全宽透明条带改造为居中悬浮的原生 vibrancy 玻璃岛（含岛内设置页、类型色半透卡片、每次唤起重放的入场动画）。

**Architecture:** 窗口层"岛即窗口"——frameless + `vibrancy: "under-window"` + `roundedCorners`，去掉 `transparent`；渲染层 body 保持透明让系统材质透上来，卡片用半透深底 + 2px 类型色顶边，全程禁用 CSS backdrop-filter；设置页从"窗口撑满+冻结截图背板"改为岛内视图，`window:set-expanded` 机制连根移除。

**Tech Stack:** Electron 37 (main: `apps/macos/electron/main.cjs`), React 19 + Vite (renderer: `apps/macos/src/`), 纯 CSS（无新依赖）。

**Spec:** `docs/superpowers/specs/2026-06-11-liquid-glass-redesign.html`（已批准，先读它）

**全局约束（每个任务都适用）：**
- 禁止引入 CSS `backdrop-filter`（性能事故史，见 spec §1 非目标）
- 不得改动：local-history.cjs、auto-update.cjs、同步/捕获/粘贴逻辑、单实例锁、panel/层级/visibleOnFullScreen 窗口行为
- 每个任务结束必须全绿：`node --check apps/macos/electron/main.cjs`、`npm --workspace @paste/macos run typecheck`、`node --test apps/macos/electron/clip-list.test.cjs apps/macos/electron/local-history.test.cjs apps/macos/electron/auto-update.test.cjs`（28/28）
- 提交信息遵循仓库风格（叙事句式英文标题，不署名 AI，参考 `git log --oneline -10`）
- 类型色**以代码 `getTypeAccent`（App.tsx:113）现有映射为准**（link=蓝, text=橙, code=紫, html=绿, image=粉）；spec §3 括号里的"文本蓝/代码紫/图片绿/链接橙"写反了，不要照它"纠正"颜色

---

### Task 1: 窗口层 — vibrancy 玻璃岛几何（含兼容性实验）

**Files:**
- Modify: `apps/macos/electron/main.cjs`（`getMainWindowBounds` ~line 1866、`createMainWindow` ~line 2009、`MAIN_PANEL_HEIGHT` 常量、`window:set-expanded` IPC ~line 3085、`mainWindowExpanded` 全局 ~line 285、hide 处理器 ~line 2186、`render-process-gone` 复位）
- Modify: `apps/macos/electron/preload.cjs`（移除 `setWindowExpanded` ~line 204）
- Modify: `apps/macos/src/vite-env.d.ts`（移除 `setWindowExpanded` 类型）

- [ ] **Step 1: 改窗口选项（这是 spec 的兼容性实验步——vibrancy × panel × 全屏可见）**

`createMainWindow` 的 `windowOptions` 中：删除 `transparent: true` 和 `backgroundColor: "#00000000"` 两行；`hasShadow: false` 改为 `hasShadow: true`；新增：

```js
    vibrancy: "under-window",
    roundedCorners: true,
```

（`visualEffectState: "active"` 已存在，保留。其余选项一律不动。）

- [ ] **Step 2: 岛几何**

`MAIN_PANEL_HEIGHT = 480` 常量替换为两个常量（放同一位置）：

```js
const ISLAND_MAX_WIDTH = 1040;
const ISLAND_HEIGHT = 420;
const ISLAND_BOTTOM_MARGIN = 16;
```

`getMainWindowBounds(workArea)` 整体替换为（同时删除函数里 `mainWindowExpanded` 分支）：

```js
const getMainWindowBounds = (workArea) => {
  const width = Math.min(ISLAND_MAX_WIDTH, Math.floor(workArea.width * 0.86));
  const height = Math.min(ISLAND_HEIGHT, workArea.height - 32);
  return {
    x: workArea.x + Math.floor((workArea.width - width) / 2),
    y: workArea.y + workArea.height - height - ISLAND_BOTTOM_MARGIN,
    width,
    height
  };
};
```

- [ ] **Step 3: 连根移除 expanded 机制**

- 删除全局 `let mainWindowExpanded = false;`
- 删除 `ipcMain.handle("window:set-expanded", ...)` 整段
- 删除 hide 处理器里的 `if (mainWindowExpanded) {...}` 块（保留 `broadcastToWindows("window:hidden", ...)`）
- 删除 `mainWindow.webContents.on("render-process-gone", ...)` 整段
- preload.cjs 删除 `setWindowExpanded` 行；vite-env.d.ts 删除其类型声明
- `grep -rn "setWindowExpanded\|mainWindowExpanded\|set-expanded" apps/macos/` 必须 0 命中（App.tsx 的调用点留给 Task 3 删，本步先确认 main/preload/types 干净；App.tsx 此时会 typecheck 报错，所以本任务**最后统一跑**验证前，先把 App.tsx 的 3 处 `setWindowExpanded` 调用行（~874、~891、~902）原地删掉调用语句但不动其余逻辑）

- [ ] **Step 4: 全绿验证 + 真机实验**

跑全局约束三件套；然后 `npm --workspace @paste/macos run pack`，启动 `apps/macos/dist-electron/mac-arm64/Pastyx.app`，验证并截图：
- 桌面上按 ⌘⇧V（或托盘点击）：岛居中贴底出现，**玻璃透出壁纸**，圆角生效
- 全屏一个应用再按热键：岛叠在全屏上、不切 Space
- 失败回退（spec §6）：`vibrancy` 行换成纯 CSS 方案——windowOptions 恢复 `transparent: true` + `backgroundColor: "#00000000"`，记录结论到任务报告，渲染层照常进行

- [ ] **Step 5: Commit**

```bash
git add apps/macos/electron/main.cjs apps/macos/electron/preload.cjs apps/macos/src/vite-env.d.ts apps/macos/src/App.tsx
git commit -m "Turn the shelf window into a centered vibrancy island"
```

---

### Task 2: 渲染层 — 岛内布局与玻璃卡片

**Files:**
- Modify: `apps/macos/src/index.css`（全面改造，重点 `:root` 变量、`.app-shell`、`.history-shelf`、`.toolbar`、`.search-input`、`.clip-card` 族、springUp）
- Modify: `apps/macos/src/App.tsx`（toolbar JSX 收进岛内、入场动画重放）

- [ ] **Step 1: 布局骨架**

- `body` 保持 `background: transparent !important`（vibrancy 透上来的前提，勿动）
- `.app-shell`：改为 `height:100vh; display:flex; flex-direction:column; padding:14px 16px 12px; background:transparent;`，删除 `justify-content:flex-end` 和 `.app-shell.active` 残留；同时删掉 App.tsx:1267 className 模板里的 `${clips.length > 0 ? 'active' : ''}` 片段（grep 'active' 搜不到它，手动删）
- `.history-shelf`：不再是 350px 底部条——改为 `flex:1; display:flex; flex-direction:column; background:transparent; border:none; box-shadow:none; padding:0;`（玻璃由窗口提供，shelf 不再画底）
- `.toolbar`：删除 `position:absolute; top:-65px`，改为岛内首行：`display:flex; gap:10px; align-items:center; margin-bottom:12px;`；App.tsx 中 toolbar JSX 不需要挪位置（它已是 history-shelf 的第一个子节点），只删掉**外层**为绝对定位准备的内联 wrapper 样式（~line 1276 有两个嵌套的 `position:relative` div：外层删，**内层保留**——它是搜索框放大镜图标绝对定位的锚点）
- `.search-input`：宽度改 `flex:1`（去掉 440px/聚焦 500px 的宽度跳变和 `transition: all`，只 transition border-color），背景 `rgba(255,255,255,0.14)`（浅色模式 `rgba(0,0,0,0.06)`）、`inset 0 1px 0 rgba(255,255,255,0.3)` 顶高光
- `.history-container`：`padding: 0 6px 6px;`，其余滚动行为不动

- [ ] **Step 2: 玻璃卡片（spec §3，方案 C）**

`:root`（浅色）与 dark 块替换卡片相关变量：

```css
:root {
  --card-bg: rgba(255, 255, 255, 0.6);
  --card-fg: #1d1d1f;
  --card-border: rgba(0, 0, 0, 0.12);
  --card-highlight: rgba(255, 255, 255, 0.55);
}
@media (prefers-color-scheme: dark) {
  :root {
    --card-bg: rgba(30, 30, 38, 0.55);
    --card-fg: #f5f5f7;
    --card-border: rgba(255, 255, 255, 0.22);
    --card-highlight: rgba(255, 255, 255, 0.15);
  }
}
```

`.clip-card`：

```css
.clip-card {
  background: var(--card-bg);
  border: 0.5px solid var(--card-border);
  border-top: 2px solid var(--accent);
  border-radius: 14px;
  box-shadow: inset 0 1px 0 var(--card-highlight), 0 8px 24px rgba(0, 0, 0, 0.18);
  transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.2s;
}
.clip-card:hover { transform: translateY(-4px); }
.clip-card.selected { border-color: var(--accent); transform: translateY(-4px); }
```

（`--accent` 已由 App.tsx 按类型注入每张卡的 style，直接用。阴影固定值，不参与 transition。）类型 pill 改为同色染色：`.clip-type-pill { color: var(--accent); background: color-mix(in srgb, var(--accent) 16%, transparent); border: none; }`

- [ ] **Step 3: 入场动画每次重放（spec §5）**

index.css：`springUp` 替换为：

```css
.island-enter { animation: islandIn 0.22s cubic-bezier(0.21, 1.02, 0.55, 1) both; }
@keyframes islandIn {
  from { transform: translateY(24px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}
```

App.tsx：已有 `onWindowShown` 监听（~line 832）。加一个 `const [showNonce, setShowNonce] = useState(0);`，在该回调里 `setShowNonce((n) => n + 1);`；`.history-shelf` 元素加 `key={showNonce}` 以外的方式重放——**不要用 key（会重挂载整列表）**，改为：

```tsx
const shelfRef = useRef<HTMLDivElement | null>(null);
useEffect(() => {
  const el = shelfRef.current;
  if (!el || showNonce === 0) return;
  el.classList.remove("island-enter");
  void el.offsetWidth; // reflow 以重置动画
  el.classList.add("island-enter");
}, [showNonce]);
```

`history-shelf` div 挂 `ref={shelfRef}` 和初始 `className="history-shelf island-enter"`。

- [ ] **Step 4: 全绿验证 + 真机外观检查（截图对比 spec mockup），Commit**

```bash
git add apps/macos/src/index.css apps/macos/src/App.tsx
git commit -m "Dress the island in glass cards with type-colored edges"
```

---

### Task 3: 设置页岛内化

**Files:**
- Modify: `apps/macos/src/App.tsx`（`openSettings` ~line 863、`closeSettings`、settings JSX ~line 1376+、删除 backdrop 状态与 `captureWindow` 调用、`SETTINGS_BACKDROP_CAPTURE_LIMIT`）
- Modify: `apps/macos/src/index.css`（`.settings-*` 族重写：删 backdrop/scrim，panel 适配岛内）
- Modify: `apps/macos/electron/main.cjs` + `preload.cjs` + `vite-env.d.ts`（`captureWindow`/`window:capture` 仅服务于背板，连根移除）

- [ ] **Step 1: App.tsx 简化**

- `openSettings` 整体替换为：`setSettingsTab("sync"); setShowSettings(true);`（删除 captureWindow/背板/expand 全部分支）
- `closeSettings`：只 `setShowSettings(false);`
- 删除 `settingsBackdropDataUrl` 状态、`SETTINGS_BACKDROP_CAPTURE_LIMIT`、settings JSX 里的 `<img className="settings-backdrop">` 与 scrim 节点
- `onWindowHidden` 回调里保留 `setShowSettings(false)`（隐藏即退出设置，行为同今天）
- settings 视图与卡片区切换：注意现状**不是**三元结构——shelf 永远渲染、`.settings-overlay`（App.tsx:1378）条件叠加在上面；需要重构为"showSettings 时设置视图替换卡片区"的条件渲染——设置面板直接占满岛内（`.settings-panel` 适配为 `width:100%; height:100%; max-height:none; border-radius:0; background:transparent; border:none; box-shadow:none;`，Tab 行 + 滚动内容区），关闭按钮/Esc 已有逻辑保留

- [ ] **Step 2: 移除 captureWindow 链路**

main.cjs 删除 `window:capture`（或同名）IPC handler（~line 2980 区域，含 `capturePage` 调用）；preload.cjs 删 `captureWindow`；vite-env.d.ts 删类型。`grep -rn "captureWindow\|capturePage\|settings-backdrop\|settingsBackdrop" apps/macos/` 0 命中。

- [ ] **Step 3: 全绿验证 + 真机检查（托盘 Settings 入口、⌘, 、保存/关闭、Esc），Commit**

```bash
git add apps/macos/src/App.tsx apps/macos/src/index.css apps/macos/electron/main.cjs apps/macos/electron/preload.cjs apps/macos/src/vite-env.d.ts
git commit -m "Fold settings into the island and retire the frozen backdrop"
```

---

### Task 4: 收尾 — 死代码清扫、发布 0.3.8

**Files:**
- Modify: `package.json` / `apps/macos/package.json` / `package-lock.json`（版本对齐）

- [ ] **Step 1: 死代码清扫**

`grep -rn "MAIN_PANEL_HEIGHT\|app-shell.active\|settings-open\|settings-overlay\|springUp" apps/macos/` —— 残留一律清掉（注意 `.settings-overlay` 在 index.css 出现两处：~278 和 ~610）；index.css 里不再被引用的 `.settings-backdrop`/`.settings-scrim` 等选择器删除。

- [ ] **Step 2: 完整真机清单（spec §7）**

普通桌面唤起（玻璃+圆角+动画）、全屏应用上唤起（不切 Space）、深浅色切换、搜索输入、文本/图片粘贴、设置三 Tab+保存、双显示器（岛跟随光标屏）、点击岛外消失、连续唤起动画每次重放。逐项记录结果。

- [ ] **Step 3: 发布**

```bash
sed -i '' 's/"version": "0.3.7"/"version": "0.3.8"/' package.json apps/macos/package.json
npm install --package-lock-only --no-audit --no-fund
git add package.json apps/macos/package.json package-lock.json
git commit -m "Release the liquid glass island as a new patch"   # 按仓库 release 提交风格补 body
git tag v0.3.8 && git push origin main && git push origin v0.3.8
npm --workspace @paste/macos run pack
# 替换 /Applications/Pastyx.app 并重启（沿用本仓库既有的 ditto 安装流程）
```
