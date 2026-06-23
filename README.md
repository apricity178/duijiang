# 🎫 中奖码管家

> 一个用于管理中奖二维码的 Web 应用，托管在 GitHub Pages，图片存储在 GitHub 仓库。

## 🚀 快速开始

### 1. Fork 或部署此仓库

点击右上角 **Fork**，或直接使用你的 GitHub 仓库。

### 2. 开启 GitHub Pages

进入仓库 → **Settings** → **Pages** → Source 选 **Deploy from a branch** → Branch 选 `main` / `(root)` → 保存。

稍等片刻，访问 `https://<你的用户名>.github.io/<仓库名>/` 即可打开网站。

### 3. 准备 Personal Access Token（PAT）

1. 前往 [GitHub Settings → Tokens](https://github.com/settings/tokens/new?scopes=repo&description=%E4%B8%AD%E5%A5%96%E7%A0%81%E7%AE%A1%E5%AE%B6)
2. 勾选 **repo** 权限
3. 生成并复制 Token（`ghp_xxxx` 开头）

### 4. 在网站中连接

打开网站后填入：
- **GitHub 用户名**
- **仓库名**（专门用于存储二维码的仓库，可新建一个私有仓库）
- **PAT Token**

点击「连接仓库」即可开始使用。

## 📂 仓库结构（自动生成）

```
my-qrcodes/
├── data/
│   └── index.json    # 二维码元数据（使用状态等）
└── images/
    ├── 1719000000000_abc12.jpg
    └── ...
```

## ✨ 功能

- 📂 批量上传二维码图片（存到 GitHub 仓库）
- 🎲 随机抽取一张未使用的码
- ✅ 标记已使用（模糊 + 灰化显示）
- ↩ 撤销标记
- ⚠️ 待兑奖数量实时提醒
- 🗑 批量清除已使用的码（同步删除仓库文件）
- 📱 手机 / 桌面自适应布局

## ⚠️ 注意事项

- Token 仅存储在**浏览器本地** (localStorage)，不上传到任何服务器
- 建议为二维码图片专门创建一个仓库（可以设为 Private，但图片 raw URL 将需要认证才能访问）
- 如果仓库设为 **Public**，raw 图片 URL 可直接访问，显示最佳
- GitHub API 有速率限制：未认证 60次/小时，已认证 5000次/小时

## 🛠 技术栈

- 纯 HTML + CSS + JavaScript（无依赖框架）
- GitHub REST API v3（图片上传、元数据存储）
- GitHub Pages（静态托管）
