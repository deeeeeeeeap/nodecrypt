# NodeCrypt

🌐 **[English README](README_EN.md)**

## 🚀 部署说明

### 方法一：一键部署到 Cloudflare Workers

点击下方按钮即可一键部署到 Cloudflare Workers：
[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button?projectName=NodeCrypt)](https://deploy.workers.cloudflare.com/?url=https://github.com/shuaiplus/NodeCrypt)

- 构建命令：npm run build
- 部署命令：npm run deploy

> 注意：此方式会基于主仓库创建新项目，后续主仓库更新不会自动同步（项目已成型，很少更新，可以直接使用方法一）。

### 方法二：自动同步 fork 并部署（推荐长期维护）
1. 先 fork 本项目到你自己的 GitHub 账号。
2. 打开 Cloudflare Workers 控制台，选择“从 GitHub 导入”，并选择你 fork 的仓库进行部署。

- 构建命令：npm run build
- 部署命令：npm run deploy

> 本项目已内置自动同步 workflow，fork 后无需任何操作，主仓库的更新会自动同步到你的 fork 仓库，Cloudflare 也会自动重新部署，无需手动维护。

### 方法三：Docker 一键部署（不稳定，不建议）

```bash
docker run -d --name nodecrypt -p 80:80 ghcr.io/shuaiplus/nodecrypt
```

！ 必须开启HTTPS，不然传输密钥会失败，导致无法进入房间。

### 方法四：本地开发部署
克隆项目并安装依赖后，使用 `npm run dev` 启动开发服务器。
使用 `npm run deploy` 部署到 Cloudflare Workers。

部署前建议执行：

```bash
npm install
npm run build
npx wrangler deploy --dry-run
npm run smoke:cloudflare
```

`smoke:cloudflare` 会本地启动 `wrangler dev`，用浏览器自动验证 Cloudflare Worker + Durable Object WebSocket、实时群聊、活动期临时历史、房间无人后清空历史等关键路径。

### 临时历史消息边界

- 仅缓存公共文本消息；图片、文件、私聊不会进入临时历史。
- 历史内容在客户端使用房间名/密码派生密钥加密，Worker 和自托管服务端只缓存密文。
- 新成员必须使用相同房间名和密码，才能解密当前活动期文本历史。
- 房间所有成员离开后，内存中的临时历史立即清空。
- Worker 部署会在每个房间 Durable Object 中持久保存 RSA 身份密钥，用于稳定 TOFU 身份校验；这不包含聊天明文。

## 📝 项目简介

NodeCrypt 是一个真正的端到端加密聊天系统，实现完全的零知识架构。整个系统设计确保服务器、网络中间人、甚至系统管理员都无法获取任何明文消息内容。所有加密和解密操作都在客户端本地进行，服务器仅作为加密数据的盲中继。

### 系统架构
- **前端**：ES6+ 模块化 JavaScript，无框架依赖
- **后端**：Cloudflare Workers + Durable Objects
- **通信**：WebSocket 实时双向通信
- **构建**：Vite 现代化构建工具

## 🔐 零知识架构设计

### 核心原则
- **服务器盲转**：服务器永远无法解密消息内容，仅负责加密数据中转
- **无明文消息数据库**：服务器不保存明文消息；Worker 仅持久化每个房间的 RSA 身份密钥，文本历史只在房间活跃期以内存密文缓存
- **端到端加密**：消息从发送方到接收方全程加密，中间任何节点都无法解密
- **临时历史**：文本消息仅在房间仍有活跃成员时以密文缓存，所有成员离开后立即清空
- **匿名通信**：用户无需注册真实身份，支持临时匿名聊天
- **多样体验**：和批量发送图片和文件，可选择主题和语言。

### 隐私保护机制

- **实时成员提醒**：房间在线列表完全透明，内任何人加入或离开都会实时通知所有成员，
- **活动期历史消息**：新加入且知道房间密码的用户可解密当前活动期的临时文本历史；房间无人后历史销毁
- **私聊加密**：点击用户头像可发起端到端加密的私密对话，房间内其他成员完全无法看到私聊内容

### 房间密码机制

房间密码作为**密钥派生因子**参与端到端加密：`最终共享密钥 = SHA256(ECDH_共享密钥 + SHA256(房间密码))`

- **密码错误隔离**：不同密码的房间无法解密彼此的消息
- **服务器盲区**：服务器永远无法获知房间密码

### 三层安全体系

#### 第一层：RSA-2048 服务器身份验证
- Worker 为每个房间 Durable Object 持久保存 RSA-2048 身份密钥，客户端采用 TOFU 方式固定并校验服务端公钥
- 客户端连接时验证服务器公钥，防止中间人攻击
- Worker 部署中，房间 Durable Object 的 RSA 私钥材料保存在该对象的存储/运行时中以保持身份稳定，不暴露给客户端；Docker/本地模式仍为进程内临时密钥

#### 第二层：ECDH-P384 密钥协商
- 每个客户端生成独立的椭圆曲线密钥对（P-384曲线）
- 通过椭圆曲线 Diffie-Hellman 密钥交换协议建立共享密钥
- 每个客户端与服务器之间拥有独立的加密通道

#### 第三层：混合对称加密
- **服务器通信**：使用 AES-256-CBC 加密客户端与服务器间的控制消息
- **客户端通信**：使用 AES-256-GCM 加密并认证客户端之间的实际聊天内容
- 每条消息使用独立的初始化向量（IV）/Nonce 和认证标签

## 🔄 完整加密流程详解

```mermaid
sequenceDiagram
    participant C as 客户端
    participant S as 服务器
    participant O as 其他客户端

    Note over C,S: 阶段1: 服务器身份验证 (RSA-2048)
    C->>S: WebSocket连接
    S->>C: RSA-2048公钥
    
    Note over C,S: 阶段2: 客户端-服务器密钥交换 (P-384 ECDH)
    C->>S: P-384 ECDH公钥
    S->>C: P-384公钥 + RSA签名
    Note over C: 验证RSA签名并派生AES-256密钥
    Note over S: 从P-384 ECDH派生AES-256密钥
    
    Note over C,S: 阶段3: 房间认证
    C->>S: 加入请求 (房间哈希，AES-256加密)
    Note over S: 将客户端添加到房间/频道
    S->>C: 成员列表 (其他客户端ID，加密)
      Note over C,O: 阶段4: 客户端间密钥交换 (P-384 ECDH)
    Note over C: 为每个成员生成P-384密钥对
    C->>S: P-384公钥包 (AES-256加密)
    S->>O: 转发客户端C的公钥
    O->>S: 返回其他客户端的P-384公钥
    S->>C: 转发其他客户端的公钥
    
    Note over C,O: 阶段5: 密码增强密钥派生
    Note over C: 客户端密钥 = SHA256(ECDH_P-384(自己私钥, 对方公钥) + SHA256(密码))
    Note over O: 客户端密钥 = SHA256(ECDH_P-384(自己私钥, 对方公钥) + SHA256(密码))
    
    Note over C,O: 阶段6: 身份验证
    C->>S: 用户名 (用客户端密钥AES-GCM加密)
    S->>O: 转发加密用户名
    O->>S: 用户名 (用客户端密钥AES-GCM加密)
    S->>C: 转发加密用户名
    Note over C,O: 双方客户端现在验证彼此身份    Note over C,O: 阶段7: 安全消息传输 (双层加密)
    Note over C: 1. AES-GCM加密并认证消息内容<br/>2. AES-256加密传输层包装
    C->>S: 双层加密消息
    Note over S: 解密AES-256传输层<br/>提取AES-GCM加密数据<br/>无法解密消息内容
    S->>O: 转发AES-GCM加密数据
    Note over O: 解密AES-256传输层<br/>AES-GCM认证并解密获得消息内容
```


## 🛠️ 技术实现

- **Web Cryptography API**：浏览器原生 P-384 ECDH 与 AES-GCM 加密实现
- **aes-js**：纯 JavaScript AES 实现，支持多种模式
- **js-sha256**：SHA-256 哈希算法实现

## 🔬 安全验证

### 加密过程验证
用户可通过浏览器开发者工具观察完整的加密解密过程，验证消息在传输过程中确实处于加密状态。

### 网络流量分析
使用网络抓包工具可以验证所有 WebSocket 传输的数据都是不可读的加密内容。

### 代码安全审计
所有加密相关代码完全开源，使用标准密码学算法，欢迎安全研究者进行独立审计。

## ⚠️ 安全建议

- **使用强房间密码**：房间密码直接影响端到端加密强度，建议使用复杂密码
- **密码保密性**：房间密码一旦泄露，该房间所有通信内容都可能被解密
- **使用最新版本的现代浏览器**：确保密码学API的安全性和性能

## 🤝 安全贡献

欢迎安全研究者报告漏洞和进行安全审计。严重安全问题将在24小时内修复。

## 📄 开源协议

本项目采用 ISC 开源协议。

## ⚠️ 免责声明

本项目仅供学习和技术研究使用，不得用于任何违法犯罪活动。使用者应遵守所在国家和地区的相关法律法规。项目作者不承担因使用本软件而产生的任何法律责任。请在合法合规的前提下使用本项目。

---
## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=shuaiplus/NodeCrypt&type=Timeline)](https://www.star-history.com/#shuaiplus/NodeCrypt&Timeline)

**NodeCrypt** - 真正的端到端加密通信 🔐

*"在数字时代，加密是保护隐私的最后一道防线"*
