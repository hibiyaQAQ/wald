# WALD OpenAI 兼容接口 Edge 版本

这套 TypeScript 版本使用标准 Fetch API，无第三方依赖，适合部署到 Deno Deploy 或 Vercel Edge Function。

## 接口

- `GET /v1/models`
- `POST /v1/chat/completions`

`Authorization` 仍然使用 Python 版相同格式：

```text
Authorization: Bearer <Base64(JSON)>
```

JSON 内容：

```json
{
  "log_public_key": "...",
  "team_id": "...",
  "wos_session": "..."
}
```

## Deno Deploy

入口文件：

```text
deno.ts
```

本地运行：

```bash
deno run --allow-net deno.ts
```

部署后 Base URL：

```text
https://你的-deno-域名/v1
```

## Vercel

入口文件：

```text
api/v1/[...path].ts
```

`vercel.json` 已将 `/v1/*` 重写到 `/api/v1/*`。

部署后 Base URL：

```text
https://你的-vercel-域名/v1
```

## 图片请求

Edge 版本保留了 Python 版当前可用的图片流程：

1. 从 OpenAI `image_url` 的 data URL 中解析 Base64。
2. 调用 WALD `/api/get-signed-url`。
3. PUT 图片二进制到 GCS 签名 URL。
4. 调用 WALD `/api/document/create`。
5. 在最终 `/api/chat` 中填充 `docs` 与 `associatedDocIds`。

## 可选环境变量

```text
WALD_AUTO_DELETE_CHAT=1
```

开启后，请求结束会自动删除 WALD 对话。默认关闭，便于排查。
