# Follow Builders HTML Spec

## 背景

codebase/follow-builders 已经有中心化抓取流程：

- GitHub Actions 每天生成 `feed-x.json`、`feed-podcasts.json`、`feed-blogs.json`
- 用户侧脚本 `scripts/prepare-digest.js` 只消费这三个 feed
- `feed-*.json` 是最新一次生成的内容快照，不是历史全集
- `state-feed.json` 只用于去重，且会清理旧记录，不能作为内容归档

因此，如果要做一个展示每日最新内容的 HTML 网页，需要在现有 feed 之上增加一层面向网页的静态数据输出和历史归档。

重要前提：上游仓库是别人的公开仓库 https://github.com/zarazhangrui/follow-builders。本规格默认不直接修改上游仓库，而是在自己的部署仓库中消费上游公开 feed，并维护自己的网页数据和历史归档。

## 目标

做一个静态网页，展示 Follow Builders 每日抓取到的最新内容，并支持按日期查看历史。

首版目标：

- 展示当天最新内容
- 支持官方博客、播客、X/Twitter 三类内容
- 支持按类型过滤
- 支持历史日期归档
- 不暴露任何 API key
- 不重新抓 X、播客 RSS 或博客源站
- 可以部署到 GitHub Pages、Vercel 或 Netlify

非目标：

- 首版不做用户登录
- 首版不做服务端数据库
- 首版不做个性化推荐
- 首版不做浏览器端调用 X API 或 pod2txt API
- 首版不替代现有 digest 生成逻辑

## 用户体验

首页默认展示最新一天内容。

页面结构：

- 顶部状态栏
  - 标题：Follow Builders Daily
  - 最近生成时间
  - 今日内容数量
  - 当前查看日期
- 筛选区
  - 全部
  - 官方博客
  - 播客
  - X/Twitter
- 内容流
  - 按发布时间倒序排列
  - 每条内容展示来源、标题或正文摘要、发布时间、原始链接
  - 长正文和播客 transcript 默认折叠
- 历史入口
  - 日期列表
  - 点击日期加载对应归档 JSON

设计风格应偏信息面板，不做营销型 landing page。重点是高密度、可扫描、快速打开原文。

## 数据来源

现有输入：

- `feed-x.json`
- `feed-podcasts.json`
- `feed-blogs.json`

这三个文件由 `scripts/generate-feed.js` 生成，并由 GitHub Actions 提交到仓库。

如果不拥有上游仓库权限，应从上游 GitHub Raw URL 读取：

```txt
https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json
https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json
https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-blogs.json
```

网页不应该直接读取第三方源站，也不应该直接使用：

- `X_BEARER_TOKEN`
- `POD2TXT_API_KEY`
- Telegram/email 等用户 delivery secret

## 数据归档

需要新增一层静态归档数据。

建议目录：

```txt
public/
  latest.json
  archive/
    index.json
    2026-06-08.json
    2026-06-09.json
```

### `public/latest.json`

包含最新一次构建后的统一内容列表，方便首页直接加载。

```json
{
  "generatedAt": "2026-06-08T08:07:09.503Z",
  "date": "2026-06-08",
  "items": []
}
```

### `public/archive/index.json`

包含可查看的历史日期列表和每一天的内容数量。

```json
{
  "updatedAt": "2026-06-08T08:10:00.000Z",
  "days": [
    {
      "date": "2026-06-08",
      "path": "archive/2026-06-08.json",
      "counts": {
        "x": 14,
        "podcast": 1,
        "blog": 1
      }
    }
  ]
}
```

### `public/archive/YYYY-MM-DD.json`

保存某一天新增的全部内容。

```json
{
  "date": "2026-06-08",
  "generatedAt": "2026-06-08T08:10:00.000Z",
  "items": []
}
```

## 统一内容模型

为了让前端更简单，构建脚本应把三类 feed 规范化为统一 `Item`。

```ts
type FeedItem = {
  id: string;
  type: "x" | "podcast" | "blog";
  sourceName: string;
  title: string;
  url: string;
  publishedAt: string | null;
  collectedAt: string;
  summaryText: string;
  bodyText?: string;
  metadata?: Record<string, unknown>;
};
```

ID 规则：

- X/Twitter：`x:<tweet.id>`
- 播客：`podcast:<guid>`
- 官方博客：`blog:<url>`

字段映射：

- X
  - `sourceName`: 作者名或 handle
  - `title`: tweet 前 80 个字符
  - `summaryText`: tweet 正文
  - `metadata`: likes、retweets、replies、handle、bio、isQuote
- 播客
  - `sourceName`: 播客名
  - `title`: episode title
  - `summaryText`: transcript 前若干字符
  - `bodyText`: 完整 transcript
  - `metadata`: guid
- 博客
  - `sourceName`: 博客名
  - `title`: article title
  - `summaryText`: description 或正文前若干字符
  - `bodyText`: 完整正文
  - `metadata`: author

## 构建流程

新增脚本建议命名：

```txt
scripts/build-site-data.js
```

职责：

1. 读取上游 GitHub Raw URL，或读取本地同步后的 `feed-x.json`、`feed-podcasts.json`、`feed-blogs.json`
2. 转换为统一 `FeedItem[]`
3. 读取已有 `public/archive/index.json`
4. 读取当天 `public/archive/YYYY-MM-DD.json`，如果存在则 merge
5. 按 `id` 去重
6. 写入当天归档文件
7. 写入 `public/latest.json`
8. 更新 `public/archive/index.json`

去重必须基于稳定 `id`，不能只按标题或发布时间判断。

## GitHub Actions 集成

如果在自己的仓库里实现网页，建议新增独立 workflow：

1. 每天定时运行
2. 拉取上游三个 feed 的 Raw URL
3. 运行 `node scripts/build-site-data.js`
4. 构建静态网页
5. 部署到 GitHub Pages、Vercel 或 Netlify

这样不需要上游仓库的写权限，也不需要上游的 secrets。

如果未来维护自己的 fork，并决定在 fork 内同时运行抓取和网页构建，则可以复用现有 workflow。现有 workflow 在生成 feed 后提交：

```txt
feed-x.json
feed-podcasts.json
feed-blogs.json
state-feed.json
```

fork 内新增网页后，workflow 可增加：

1. 运行 feed 生成
2. 运行 `node scripts/build-site-data.js`
3. 构建静态网页
4. 提交或部署 `public/` / `dist/`

注意：fork 方式如果要自行生成 feed，需要配置 `X_BEARER_TOKEN` 和 `POD2TXT_API_KEY`。如果只是消费上游 feed，则不需要这些 secrets。

首版建议使用独立网页仓库消费上游 feed，并把静态页面和归档 JSON 提交到自己的仓库，降低权限和维护复杂度。

## 前端实现方案

首版可使用无框架实现：

```txt
public/
  index.html
  app.js
  styles.css
  latest.json
  archive/
    index.json
```

`app.js` 职责：

- 加载 `latest.json`
- 加载 `archive/index.json`
- 渲染日期列表
- 根据筛选类型渲染内容列表
- 点击历史日期时加载对应 `archive/YYYY-MM-DD.json`
- 使用 `localStorage` 保存用户最近选择的筛选类型

如果后续 UI 复杂度上升，再迁移到 Vite + React。

## 内容展示规则

X/Twitter：

- 默认展示全文
- 显示作者、handle、互动数据、原帖链接
- quote tweet 只显示 quoted tweet id，不尝试二次抓取

播客：

- 默认展示标题、播客名、发布时间、YouTube 链接
- transcript 默认折叠
- 长 transcript 使用前端展开，不在 HTML 中硬截断数据

官方博客：

- 默认展示标题、来源、发布时间、作者、原文链接
- 正文默认展示预览，支持展开全文

## 部署方案

推荐顺序：

1. GitHub Pages：最适合独立静态网页仓库和 GitHub Actions
2. Vercel：适合后续迁移到 Vite/React/Next.js
3. Netlify：适合纯静态站

首版建议使用 GitHub Pages，避免新增服务依赖。

## 风险与约束

- 上游仓库不受自己控制，feed 结构、文件路径或更新频率可能变化
- 上游 `feed-*.json` 是 latest 快照，不包含历史，自己的归档任务必须稳定运行
- `feed-*.json` 不包含历史内容，必须在每天生成后立即归档
- 如果某天 workflow 失败，那天可能没有归档
- 播客 transcript 可能很长，归档 JSON 会逐渐变大
- 博客 HTML 抽取依赖目标网站结构，源站改版可能导致正文为空
- X API 受 rate limit 影响，某天可能只有部分账号内容

## 后续增强

- 生成 `digest-latest.json`，存放 LLM 摘要结果
- 增加全文搜索索引，例如 `public/search-index.json`
- 增加 RSS/Atom 输出
- 增加按来源订阅或隐藏功能
- 增加“已读”和“收藏”，用 `localStorage` 保存
- 数据量增长后迁移到 SQLite、Turso 或 Supabase

## MVP 验收标准

- 打开首页可以看到最新一天内容
- 三类内容都能正确渲染
- 类型筛选可用
- 日期归档可用
- 刷新页面不丢失数据
- 不需要任何前端 API key
- GitHub Actions 可以自动更新 feed 和网页数据
