# CloudCheckBJMF

班级魔方自动签到云端版，提供扫码连接账号、分时轮询、地图坐标组、课程日历、签到日志、PushPlus 微信提醒和日历 AI 助手。

正式网站：[https://davidsun.kdns.fr](https://davidsun.kdns.fr)

## 本地运行

```bash
corepack enable
pnpm install
pnpm test:calendar-ai
pnpm exec wrangler dev
```

## 自动部署

推送到 `main` 会由 GitHub Actions 先运行日历回归测试，再部署到 Cloudflare Workers。首次配置请参阅 [GITHUB_DEPLOY.md](GITHUB_DEPLOY.md)。

请勿提交 `.dev.vars`、Cookie、PushPlus Token、数据库导出或 Cloudflare API Token。
