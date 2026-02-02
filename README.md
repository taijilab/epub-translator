# EPUB 多语言翻译工具

一个功能强大的EPUB文件翻译工具，支持批量翻译、语言检测、格式保持等功能。

## ✨ 主要功能

- 🌍 **多语言支持** - 支持中文、英语、日语、韩语、法语、西班牙语、德语、俄语、葡萄牙语之间的互译
- 📊 **智能文件分析** - 自动检测文件字数、语言类型
- ⚡ **高速翻译** - 智能段落合并 + 并发处理，翻译速度提升10-20倍
- 📈 **实时进度** - 按字数显示翻译进度，实时反馈
- 🔄 **横竖排转换** - 自动检测竖排EPUB并转换为横排
- 👁️ **翻译预览** - 翻译完成后可在线预览效果
- 💾 **原文件保护** - 原文件完全不被修改，生成新文件
- 📝 **Token统计** - 实时显示token消耗和预估费用

## 🚀 使用方法

### 在线使用

1. 打开 `index.html` 文件
2. 上传EPUB文件
3. 选择源语言和目标语言
4. 配置API服务（支持OpenRouter、智谱AI等）
5. 点击"开始翻译"
6. 预览翻译结果
7. 下载翻译后的EPUB文件

### 本地运行

```bash
# 使用任意HTTP服务器
python -m http.server 8000
# 或
npx serve
```

然后访问 http://localhost:8000

## 🔑 API配置

### OpenRouter（推荐）

1. 访问 [OpenRouter](https://openrouter.ai/keys) 获取API Key
2. 选择服务：OpenRouter
3. 输入API Key
4. 选择模型（推荐DeepSeek Chat）

### 智谱AI

1. 访问 [智谱AI开放平台](https://open.bigmodel.cn/) 获取API Key
2. 选择服务：智谱AI
3. 输入API Key和API地址

## 📁 文件说明

- `index.html` - 主程序文件（包含所有功能）
- `.gitignore` - Git忽略文件配置
- `README.md` - 项目说明文档

## 🎯 支持的语言

- 🇨🇳 中文
- 🇺🇸 英语
- 🇯🇵 日语
- 🇰🇷 韩语
- 🇫🇷 法语
- 🇪🇸 西班牙语
- 🇩🇪 德语
- 🇷🇺 俄语
- 🇵🇹 葡萄牙语

## 💡 特色功能

### 1. 智能语言检测
上传文件后自动检测主要语言并自动选择源语言。

### 2. 竖排转横排
自动检测竖排EPUB（日文漫画等）并转换为横排，翻译后阅读更舒适。

### 3. 格式保持
- 保留原始XHTML结构
- 保留自闭合标签
- 保留DOCTYPE和命名空间
- 保留CSS样式

### 4. 实时Token统计
显示输入/输出/总Token数量，并预估费用。

### 5. 翻译预览
翻译完成后可在网页中直接预览翻译效果，确认无误后再下载。

## 📋 系统要求

- 现代浏览器（Chrome、Firefox、Safari、Edge）
- 稳定的网络连接
- API服务的有效密钥

## 🛠️ 技术栈

- 纯HTML + JavaScript
- Tailwind CSS（样式）
- JSZip（EPUB文件处理）
- OpenAI兼容API

## 📄 开源协议

MIT License

## 🤝 贡献

欢迎提交Issue和Pull Request！

---

**享受您的EPUB翻译之旅！** 📚✨
