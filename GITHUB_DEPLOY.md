# GitHub 自动部署

将本目录创建为独立仓库，例如 `ACACAACaaac/AutoCheckBJMF-Cloud`。每次推送到 `main`，GitHub Actions 会先运行日历回归测试，再部署到 Cloudflare。

在 GitHub 仓库的 `Settings -> Secrets and variables -> Actions` 添加：

| Secret | 值 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare 创建的 API Token |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Dashboard 中的 Account ID |

Token 建议最小权限为：Account 的 `Workers Scripts:Edit`、`Workers Routes:Edit`、`D1:Edit`、`Durable Objects:Edit`，以及 Zone 的 `Zone:Read` 和 `DNS:Edit`（仅首次需要更新自定义域名时）。

不要提交 `.dev.vars`、任何 Cookie、PushPlus Token、数据库导出或 Cloudflare API Token。它们已被 `.gitignore` 排除。
