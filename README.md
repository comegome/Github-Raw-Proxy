# GitHub-Raw-Proxy

> [!WARNING]
> **本 Worker 没有任何客户端鉴权。** 任何拿到地址的人，都能读取你限定的那个仓库里的内容。
>
> 它**强制要求**配置 `GH_NAME` + `GH_REPO`（缺任一个直接返回 500），所以从设计上不会变成一个面向 `raw.githubusercontent.com` 的公开代理。
> 除此之外请务必做到：**令牌用最小权限（Fine-grained，仅 `Contents: Read`）**、**不要把地址公开**。

用 Cloudflare Workers 做中间层，把 GitHub **私有仓库**里的原始文件（raw）直接暴露成一个 URL。
令牌只存在于 Worker 的环境变量里：不写进 URL、不回给调用方、不打日志 —— 访问者全程不需要接触它。

## ✨ 功能说明

- 🔐 **代理私有仓库的 raw 文件**：访问者不持有令牌，令牌只在 Worker 侧使用
- 📌 **限定仓库**：`GH_NAME` + `GH_REPO` 必填，请求路径只能落在你指定的这一个仓库里，不存在绕过形态
- 🎯 **路径即地址**：`https://<你的域名>/<分支>/<仓库内路径>` 直接对应上游地址
- 🗂️ **支持任意分支**：分支从地址里取；设了 `GH_BRANCH` 后可以省掉
- ⏩ **支持断点续传与条件请求**：透传 `Range` / `If-None-Match` / `If-Modified-Since`，正确处理 `206` / `304`
- 🪶 **只做取文件**：仅 `GET` / `HEAD`（其它方法 405）；`HEAD` 原样传给上游，不会白下载整个文件
- 🎭 **首页伪装**：可配成 302 跳转或反向代理一个第三方页面；都不配时返回一个伪装成 nginx 的静态页
- 🧱 **无跨请求状态**：每次请求只从环境变量读配置，不存在令牌串请求
- 🛡️ **路径穿越防护**：拦住编码后的 `.` / `/`（含嵌套编码），且不误杀 `100%25.txt` 这类合法文件名
- ⚠️ **没有客户端鉴权** —— 这是设计取舍，不是遗漏，请读下面的安全说明

## 🚀 部署方法

> [!IMPORTANT]
> **Cloudflare 侧的 Worker 名字，必须和本仓库 `wrangler.toml` 里的 `name` 完全一致。**
> Cloudflare 在每次构建前都会核对这两处；不一致会被判为构建失败，并自动在你的仓库里开一个 PR 把 `name` 改成 Cloudflare 上的名字 —— 只有合并那个 PR 之后才会重新构建。
> 本仓库当前的 `name` 是 `github-raw-proxy`。要改名请两边一起改：
>
> - **改仓库侧**：修改 `wrangler.toml` 的 `name`，推送
> - **改 Cloudflare 侧**：进入该 Worker → **设置 → 重命名**（重命名会一并换掉默认地址）
>
> 名字同时就是默认地址 `<name>.<你的子域>.workers.dev`，所以还必须满足 DNS 标签规则：**不超过 63 个字符，只能用字母、数字和短横线，且不能以短横线开头或结尾**。

### 方式一：Cloudflare Dashboard（最快）

1. Cloudflare 控制台 → **Workers & Pages** → **创建** → **Worker**
2. 名字填成与 `wrangler.toml` 相同的 `github-raw-proxy`（或你自己改定的那个名字），点部署
3. 进入该 Worker → **编辑代码**，把本仓库 `_worker.js` 的内容整段粘贴进去 → 部署
4. 进入 **设置 → 环境变量**，按下表添加变量 → 保存
5. 访问 `https://<你的域名>/<分支>/<仓库内路径>` 验证

### 方式二：连接本仓库（推送即自动部署）

Cloudflare 控制台 → **Workers & Pages** → **创建** → **导入 Git 仓库** → 选择本仓库。

- **Worker 名字必须与 `wrangler.toml` 的 `name` 一致**（本仓库为 `github-raw-proxy`）—— 这就是上面那条要求的来源：Git 集成的构建正是按这个一致性校验的
- **构建命令**：留空
- **部署命令**：用默认的 `npx wrangler deploy`（`wrangler.toml` 已配好 `main` / `keep_vars` / `[observability]`）

之后每次 `git push` 都会自动部署；环境变量仍在 **设置 → 环境变量** 里配置。

### 方式三：Wrangler CLI（本地）

```bash
npm install -g wrangler
wrangler login
wrangler deploy                  # 读取同目录的 wrangler.toml，部署到 name 指定的 Worker
wrangler secret put GH_TOKEN     # 加密存储；不要把 GH_TOKEN 写进 wrangler.toml
wrangler secret put GH_NAME      # 也可以放 wrangler.toml 的 [vars]（它们不是机密）
wrangler secret put GH_REPO
```

用 CLI 时同一个道理：`wrangler deploy` 部署到 `wrangler.toml` 里 `name` 指定的那个 Worker。如果 Dashboard 上连的也是同名 Worker，两边就对上了；否则会**多出一个** Worker。

> `wrangler.toml` 里的 `keep_vars = true` 必须保留：没有它，`wrangler deploy` 会清空你在 Dashboard 里设的环境变量。

## 📖 使用方法

以 `GH_NAME=octocat`、`GH_REPO=hello-world`、`GH_BRANCH=main` 为例，取仓库里的 `docs/a.txt`：

```url
https://<你的域名>/main/docs/a.txt      # 分支写在地址里
https://<你的域名>/docs/a.txt           # 设了 GH_BRANCH 之后可以省掉
```

上游实际请求的是 `https://raw.githubusercontent.com/octocat/hello-world/main/docs/a.txt`。

**拼接规则**：`https://<你的域名>/<分支>/<仓库内路径>`
→ `https://raw.githubusercontent.com/<GH_NAME>/<GH_REPO>/<GH_BRANCH 或地址里的分支>/<仓库内路径>`。

不支持「完整 raw URL」形态（形如 `https://<你的域名>/https://raw.githubusercontent.com/...`）：它只会被当成仓库内的一个普通路径。

## ⚙️ 变量列表

在 Worker 的 **设置 → 环境变量** 里配置：

| 变量 | 必填 | 示例 | 说明 |
|--|--|--|--|
| `GH_TOKEN` | ✅ | `github_pat_xxxxxx` | 你的 GitHub 令牌。建议 Fine-grained、只对该仓库授予 `Contents: Read`，不要用 classic 的 `repo` 全权令牌 |
| `GH_NAME` | ✅ | `octocat` | GitHub 用户名 |
| `GH_REPO` | ✅ | `hello-world` | GitHub 仓库名 |
| `GH_BRANCH` | ❌ | `main` | 分支名。设置后，地址里就可以省掉分支段 |
| `URL302` | ❌ | `https://t.me/xxx` | 首页 302 跳转到该地址；设了它就优先于 `URL` |
| `URL` | ❌ | `https://example.com/` | 首页返回该地址的内容（伪装） |
| `ERROR` | ❌ | `文件不存在` | 替换「取不到文件」那条提示文案 |

- **`GH_TOKEN` / `GH_NAME` / `GH_REPO` 缺任一个，都会直接返回 500** —— 故意的。
- `GH_NAME` / `GH_REPO` / `GH_BRANCH` 的值会自动去掉首尾空白和多余的斜杠；只填了空白等同于没填（会触发 500）。
- `URL` / `URL302` 支持填多个地址（空白、换行或逗号分隔，随机取一个）。注意 `|` 也是分隔符，别把它写进 URL。
- `URL` 和 `URL302` 都不设时，首页返回一个伪装成 nginx 的静态页。
- 用 `URL` 做首页伪装时，**不会把你的请求头（`Cookie` / `Authorization` 等）转给你配置的第三方地址**。

## ⚠️ 安全说明

**端点没有任何客户端鉴权，本质上是公开的。** 四条措施各自挡住什么：

| 措施 | 挡住的是什么 |
|--|--|
| **限定仓库（`GH_NAME` + `GH_REPO`）** | 缺失时直接 500，不可能退化成「谁都能借它读任意仓库」的公开代理，也不存在用完整 URL 绕过限定的形态 |
| **令牌用最小权限** | 即使地址泄漏，能读到的也只有那一个仓库（Fine-grained + 仅 `Contents: Read`） |
| **不公开地址** | 抬高被撞见的门槛。注意：如果这份配置放在**公开仓库**里，`wrangler.toml` 里的 Worker 名字也是公开的，这一层只能算降低可见度 |
| **能吊销** | 怀疑泄漏时立刻在 GitHub 吊销并更换令牌 |
| **需要真正的访问控制** | 用 [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/) 在 Worker 前面加一层，而不是在代码里手搓令牌 |

## 📌 注意事项

- **上游 CDN 缓存**：`raw.githubusercontent.com` 自己前面有一层 CDN，响应带 `cache-control: max-age=300`（本 Worker 原样透传）。所以分支被删、文件被改之后，**最多约 5 分钟内仍可能取到旧副本**。这是上游的陈旧副本，不是本 Worker 缓存，也不是安全漏洞。
- **`?cb=时间戳` 之类的 query 无法绕过缓存**：raw 的缓存键是 `vary: Authorization, Accept-Encoding`，query string 不参与。
- 要确认某个 ref 是否真的存在，请查 `github.com` 页面或 `api.github.com/repos/<owner>/<repo>/branches`，**不要拿 raw 的可取性当判据**。
- **不要把 `GH_TOKEN` 写进 `wrangler.toml`**：用 `wrangler secret put GH_TOKEN` 或 Dashboard 的加密变量。
- 本 Worker 会连 `404` 一起透传上游的状态码，便于排错。

## ❌ 错误处理

| 消息 | 状态码 | 触发条件 |
|--|--|--|
| `服务器GitHub TOKEN配置错误` | 500 | 没有配置 `GH_TOKEN` |
| `服务器未配置 GH_NAME 或 GH_REPO` | 500 | 没有（或没填有效值）配置 `GH_NAME` / `GH_REPO` |
| `无法获取文件，检查路径或TOKEN是否正确。` | 上游返回的状态码 | 路径错误，或令牌无权访问该文件。可用 `ERROR` 覆盖文案 |
| `非法路径` | 400 | 路径中残留了被编码的 `.` / `/` / `\`（`%2e` `%2f` `%5c`，含嵌套编码） |
| `Method Not Allowed` | 405 | 只支持 `GET` / `HEAD` |
| `服务器内部错误` | 500 | 未预期的错误，细节只写进 Worker 日志；响应头 `x-raw-error` 会带上错误类型名（不含堆栈） |

## 🔀 与上游的差异

本项目是 [cmliu/CF-Workers-Raw](https://github.com/cmliu/CF-Workers-Raw) 的修改版。行为**不兼容**之处：

- 删除全部客户端鉴权（`?token=` 参数 / `TOKEN` / `TOKEN_PATH`），只保留服务端 `GH_TOKEN`
- `GH_NAME` + `GH_REPO` 改为**必填**，缺失直接 500（上游不配置也能跑，但会变成一个公开代理）
- 删除「完整 raw URL」兼容分支（上游可用它绕过仓库限定）
- 只允许 `GET` / `HEAD`，透传 `Range` / 条件请求，修正 `304` / `204` / `205` 的空正文处理
- 修复上游模块级 `let token` 造成的**跨请求令牌泄漏**
- 首页伪装分支不再转发调用方的请求头
- 路径穿越防护改为逐字节解码，杜绝畸形编码掩护绕过

## 🙏 感谢与许可

本项目基于 [cmliu/CF-Workers-Raw](https://github.com/cmliu/CF-Workers-Raw) 修改，
感谢原作者 **[@cmliu](https://github.com/cmliu)**，以及上游致谢里提到的 ChatGPT 提供的最初思路。

上游以 **GPL-3.0** 发布，本项目同样以 **GPL-3.0** 发布，详见 [LICENSE](LICENSE)。
