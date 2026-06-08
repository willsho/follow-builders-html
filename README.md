# Follow Builders HTML

一个静态网页，展示 [Follow Builders](https://github.com/zarazhangrui/follow-builders) 每天抓取到的最新内容（官方博客、播客、X/Twitter），并支持按日期查看历史归档。

- 纯静态，无后端、无数据库、无前端 API key
- 消费上游公开 feed，不重新抓取 X / 播客 RSS / 博客源站
- 自带每日历史归档，可部署到 GitHub Pages

## 工作原理

```
上游公开 feed (raw.githubusercontent.com)
  feed-x.json / feed-podcasts.json / feed-blogs.json
            │
            ▼
  scripts/build-site-data.js   规范化为统一 FeedItem[] + 按天归档去重
            │
            ▼
  public/
    latest.json                最新一天，首页直接加载
    archive/index.json         历史日期列表 + 每天分类计数
    archive/YYYY-MM-DD.json     某天新增的全部内容
    index.html / app.js / styles.css   无框架前端
```

构建脚本只读取上游 feed 快照，永远不需要 `X_BEARER_TOKEN`、`POD2TXT_API_KEY` 等 secret。

## 统一内容模型

```ts
type FeedItem = {
  id: string;                 // x:<tweetId> | podcast:<guid> | blog:<url>
  type: "x" | "podcast" | "blog";
  sourceName: string;
  title: string;
  url: string;
  publishedAt: string | null; // ISO，无法解析时为 null
  collectedAt: string;        // 对应 feed 的 generatedAt
  summaryText: string;
  bodyText?: string;          // 播客 transcript / 博客正文全文
  titleZh?: string;           // 中文译文（构建时生成，非 X）
  summaryZh?: string;         // 中文译文（构建时生成）
  metadata?: Record<string, unknown>;
};
```

去重基于稳定 `id`，不按标题或时间判断；同一天重复运行幂等。

## 本地开发

```bash
# 1) 生成数据（从上游拉取）
npm run build

# 或用本地 feed（把 feed-*.json 放进 ./feeds/）
npm run build:local

# 2) 本地预览
npm run serve   # http://localhost:4173
```

构建脚本支持的环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `UPSTREAM_BASE` | `…/zarazhangrui/follow-builders/main` | 上游 raw feed 基地址 |
| `FEED_DIR` | — | 设置后改为读取本地 `feed-*.json` |
| `PUBLIC_DIR` | `public` | 输出目录 |
| `SITE_DATE` | 今天(UTC) | 强制归档日期 `YYYY-MM-DD`（用于测试） |
| `SUMMARY_LEN` | `280` | `summaryText` 截断长度 |
| `DEEPSEEK_API_KEY` | — | 设置后启用构建时英译中翻译 |
| `TRANSLATE_MOCK` | — | `=1` 时不调网络，给译文加 `〔译〕` 前缀（本地干跑） |
| `TRANSLATE` | — | `=0` 强制关闭翻译 |
| `DEEPSEEK_BASE` | `https://api.deepseek.com` | DeepSeek API 基地址 |
| `DEEPSEEK_MODEL` | `deepseek-v4-flash` | 翻译用模型 |
| `TRANSLATE_BATCH` | `20` | 每次请求翻译的字符串条数 |

## 多语言（构建时英译中）

内容几乎都是英文。构建脚本会在拉到 feed 后用 **DeepSeek** 把每条的 `title` 和
`summaryText` 翻成简体中文，写入 `titleZh` / `summaryZh`，前端用顶部「中文 / 原文」
开关切换显示，记忆在 `localStorage`。

- **不在浏览器里调翻译 API**：key 只存在于构建环境，前端零 key。
- **只翻标题 + 摘要**：博客正文与播客 transcript 全文不翻译（成本考量）；中文模式下
  这两类显示中文摘要，切到「原文」可展开查看全文。
- **增量翻译**：已翻过的条目带着译文存进归档，重跑只翻新增内容，不重复消耗额度。
- **可选**：未配置 `DEEPSEEK_API_KEY` 时自动跳过，前端回退原文。

本地干跑（不花钱、不联网）：

```bash
TRANSLATE_MOCK=1 FEED_DIR=./feeds node scripts/build-site-data.js
```

CI 中在仓库 **Settings → Secrets and variables → Actions** 添加 `DEEPSEEK_API_KEY` 即可。

## 部署（Vercel）

职责分工：

- **GitHub Actions** [.github/workflows/build.yml](.github/workflows/build.yml)：每天定时拉 feed → 运行
  `build-site-data.js`（含英译中）→ 把 `public/latest.json` 和 `public/archive/`
  **提交回仓库**（归档历史持久化在 git，不会因上游只留 latest 而丢）。
- **Vercel**：通过 Git 集成托管 `public/`，**不跑 build**。Actions 每次提交数据都会触发
  Vercel 自动重新部署。

[vercel.json](vercel.json) 已把项目配成纯静态：`outputDirectory: public`、无 build
command，并对 `*.json` 设置较短的 CDN 缓存（数据每天更新）。

首次接入步骤：

1. 把仓库推到 GitHub。
2. Vercel → **Add New Project** → 导入该仓库。框架选 **Other**，其余用 `vercel.json`
   的默认（Output Directory = `public`，Build Command 留空）。
3. GitHub 仓库 **Settings → Secrets and variables → Actions** 添加 `DEEPSEEK_API_KEY`
   （翻译在 Actions 里跑，**不需要**配到 Vercel 环境变量）。
4. 在 Actions 页手动触发一次 **Refresh site data**（或等每日 cron），生成并提交数据 →
   Vercel 随即部署。

> 上游 `feed-*.json` 只是最新快照、不含历史，所以本仓库必须在每天生成后立即归档；若某天 workflow 失败，则那天可能缺归档。

> 想改用 GitHub Pages？把 workflow 换回带 `actions/deploy-pages` 的版本、并在 `public/`
> 放回 `.nojekyll` 即可；两种部署不必同时启用。
