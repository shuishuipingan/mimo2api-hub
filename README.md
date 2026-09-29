# MiMo2API-Hub — 小米 MiMo 免费通道多账号网关

<p align="center">
  <a href="https://github.com/shuishuipingan/mimo2api-hub/releases"><img src="https://img.shields.io/badge/Release-v1.0.0-2496ED?style=flat-square" alt="Version 1.0.0"></a>
  <img src="https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square" alt="Node.js 22+">
  <img src="https://img.shields.io/badge/API-OpenAI_Compatible-412991?style=flat-square" alt="OpenAI API">
  <img src="https://img.shields.io/badge/账号池-多账号轮询-2496ED?style=flat-square" alt="Multi Account">
  <img src="https://img.shields.io/badge/看板-Web_Dashboard-0DBD8B?style=flat-square" alt="Web Dashboard">
  <img src="https://img.shields.io/badge/License-MIT-green.svg?style=flat-square" alt="License">
  <img src="https://img.shields.io/badge/Vibe_Coding-100%25-ff69b4?style=flat-square" alt="Vibe Coding">
</p>

本项目将小米 **MiMo 桌面版** 的免费模型通道封装为标准 **OpenAI 兼容接口**，免桌面端常驻运行。支持多账号池负载轮询、429 限流按账号自动冷却与轮换、长效凭据本地缓存（登录一次长期免维护）、模型目录自动刷新与能力实测探测、免费通道剩余用量查询、以及一个功能完整的 Web 监控看板。

- **免桌面端运行**：从桌面端登录态提取长效凭据后，直连云端免费通道，无需保持 MiMo 桌面版开启。
- **多账号池**：多账号轮询调度、按账号维度处理限流冷却、同一 API Key 会话亲和粘住同一账号。
- **429 限流智能处理**：解析上游"请约 N 秒后重试"，只冷却触发的账号并自动轮换下一个；全部冷却时替客户端透明等待。
- **模型能力实测**：模型目录自动跟随桌面端刷新，上下文窗口 / 最大输出 / reasoning_effort 支持度逐项实测并存档。
- **用量一目了然**：免费通道剩余百分比（与桌面端显示一致）、重置日期、当前套餐，以及付费开放平台余额（SSO 自动登录）。
- **现代化 Web 看板**：账号池管理、API Key 多 Key 管理、用量统计、模型能力速查、请求流水。

> ⚡ **Vibe Coding 产物**：本项目为 100% Vibe Coding 协同产物，由人类开发者提出架构与业务意图，AI 助手端到端完成逆向分析、链路调度与界面编写。

---

## 一、快速启动

### 1. 准备登录态（二选一）

- **方式 A（推荐）**：安装并打开一次小米 MiMo 桌面版，登录小米账号；网关启动时会自动提取长效凭据并加入账号池。
- **方式 B**：打开 Web 看板的「账号池」，用「账号密码登录」或「导入凭据」手动添加账号。

> passToken 是账号级长效凭据，导入一次长期有效。之后即使 MiMo 桌面版在运行、cookie 库被锁死，网关也能用本地缓存静默续期。

### 2. 本机启动

双击运行 **`启动代理.bat`**，或命令行执行：

```bash
node mimo-api-proxy.mjs
```

- **API 接口地址**：`http://127.0.0.1:8788/v1`
- **Web 监控看板**：`http://127.0.0.1:8788/`（面板密码默认 `admin`，请尽快修改）
- **API Key**：默认未配置（本机免密）；给局域网/其他设备用时，在 `config.json` 或看板「设置」里配置。

### 3. 客户端接入

任何 OpenAI 兼容客户端（Cherry Studio / ChatBox / Cline / Dify / SillyTavern…）直接填写：

- **Base URL**：`http://127.0.0.1:8788/v1`
- **API Key**：你在看板或 `config.json` 里配置的 Key（未配置则留空）
- **模型名称**：`xiaomi/mimo-v2.6-pro`、`xiaomi/mimo-v2.6-flash`，或短别名 `mimo-pro`、`mimo-flash`（自动指向最新版本）

curl 示例：

```bash
curl http://127.0.0.1:8788/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 你的API_Key" \
  -d '{"model":"mimo-pro","messages":[{"role":"user","content":"你好"}]}'
```

Python 示例：

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8788/v1",
    api_key="你的API_Key",
)
r = client.chat.completions.create(
    model="mimo-pro",
    messages=[{"role": "user", "content": "你好"}],
)
print(r.choices[0].message.content)
```

### 4. 配置说明

复制 `config.example.json` 为 `config.json` 后按需修改（完整字段说明见示例文件内注释）：

| 配置项 | 说明 |
|---|---|
| `listenHost` / `listenPort` | 监听地址与端口，`0.0.0.0` = 局域网可访问 |
| `apiKeys` | 访问网关的 API Key 列表，留空 = 本机免密 |
| `mode` | `auto`（优先免桌面端）/ `standalone`（仅云端直连）/ `engine`（仅本地引擎） |
| `poolRotateOn429` | 云端限流时自动轮换下一个就绪账号 |
| `poolKeepaliveHours` | 账号池保活周期（小时），定期校验并静默续期 |
| `rateLimitHoldMs` | 限流时替客户端透明等待的上限，超时回 429 + Retry-After |

---

## 二、账号池与登录方式

网关内置多账号池，三种添加方式（看板「账号池」页操作）：

- **桌面端一键导入**：扫描本机 MiMo 桌面端所有 cookie 库，按账号分组导入（桌面端切换过账号时可一次导入多个）。
- **账号密码登录**：走小米 passport 经典流程；若被小米风控/验证码拦截，看板会给出明确指引，改用下面两种方式即可。
- **手动凭据导入**：粘贴 `userId` + `passToken`（可从桌面端 cookie 库或浏览器 devtools 获取）。

调度策略：

- **轮询负载**：多个账号按 round-robin 轮换，自动跳过禁用/冷却中的账号。
- **会话亲和**：同一 API Key 的请求固定使用同一账号（2 小时 TTL），保持上下文连续。
- **按账号限流冷却**：某个账号触发 429 时只冷却它并自动轮换下一个账号，其余账号不受影响；全部冷却时统一透明等待。
- **自动保活**：按配置周期校验全部账号会话，失效的用本地长效凭据静默续期，全程无需人工干预。

---

## 三、模型与能力

- 模型目录自动跟随 MiMo 桌面端刷新（当前 V2.6 系列：`mimo-v2.6-flash` / `mimo-v2.6-pro`）。
- 每个模型的上下文窗口、最大输出、reasoning_effort 支持度会**实际发请求探测**并存档，看板「模型库」页可查。
- 上游明确拒绝过的模型（区域裁剪 / 套餐档位不足）会自动从对外列表移除，定期自动重试。
- 云端对 `reasoning_effort` 的支持按模型实测区分，代理自动处理，客户端随便传不会 400。

---

## 四、看板与接口一览

访问 `http://127.0.0.1:8788/` 即可使用集成看板，核心接口包括：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | / | Web 监控看板 |
| POST | /v1/chat/completions | 标准 Chat Completions 接口（SSE 流式） |
| GET | /v1/models | 模型列表（含能力与规格） |
| GET | /api/accounts | 账号池状态 |
| GET | /api/quota | 免费通道剩余用量 + 开放平台余额 |
| GET | /api/usage | 本地用量流水与汇总 |
| GET | /api/models/capabilities | 模型能力实测数据 |

---

## 五、免责声明 (Disclaimer)

1. 本项目为非官方自托管网关，仅供技术研究、协议学习与个人合法授权账号在私有环境测试使用。
2. 本项目不提供任何账号及额度。请严格遵守官方服务条款，禁止用于任何商业转售、恶意并发或违规滥用。
3. 使用本项目产生的一切后果由使用者自行承担。
