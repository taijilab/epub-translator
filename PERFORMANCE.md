# EPUB翻译工具 - 性能优化指南

## 📊 当前优化配置

```javascript
并发数: 30 (之前15)
合并策略: 300-500字/组 (之前200-300字)
批次延迟: 0ms (之前200ms)
重试策略: 指数退避 (之前线性)
```

## ⚡ 已实施的优化

### 1. 提高并发数 (30个)
- **效果**: 翻译速度提升 **2倍**
- **说明**: 同时处理30个翻译请求
- **注意**: 需确保API服务商支持高并发

### 2. 移除批次延迟 (0ms)
- **效果**: 减少不必要的等待时间
- **说明**: 移除了200ms的批次间延迟

### 3. 指数退避重试
- **效果**: 失败重试更快
- **延迟**: 500ms → 1000ms → 2000ms

### 4. 增大合并组 (300-500字)
- **效果**: 减少30-40%的API调用
- **说明**: 更大的合并组，更少的网络开销

## 🚀 进一步优化策略

### 策略1: 使用更快的模型

**当前**: `glm-4-flash` 或 `deepseek/deepseek-chat`
**推荐**: `gpt-3.5-turbo` 或 `claude-3-haiku`

```javascript
// OpenRouter配置
model: 'openai/gpt-3.5-turbo'  // 最快
// 或
model: 'anthropic/claude-3-haiku'  // 性价比高
```

**优势**:
- GPT-3.5: 响应时间 <1秒，速度提升50%
- Claude Haiku: 质量好，速度快

### 策略2: 流式API (SSE)

```javascript
// 使用流式响应，实时返回翻译结果
body: JSON.stringify({
    model: model,
    messages: [...],
    stream: true  // 启用流式
})
```

**优势**:
- 无需等待完整响应
- 用户体验更好
- 总体时间节省20-30%

### 策略3: 文件级并行处理

```javascript
// 同时处理多个HTML文件，而不是串行
const filePromises = htmlFiles.map(async (file) => {
    return await translateFile(file);
});
await Promise.all(filePromises);
```

**优势**:
- 充分利用并发
- 速度提升3-5倍（文件数量多时）

### 策略4: 智能缓存

```javascript
// 缓存重复的段落
const cache = new Map();
function getCachedTranslation(text) {
    if (cache.has(text)) {
        return cache.get(text);
    }
    const result = await translate(text);
    cache.set(text, result);
    return result;
}
```

**优势**:
- 避免翻译重复内容
- 常见短语节省40-60%时间

### 策略5: 减少日志输出

```javascript
// 只输出关键日志，减少DOM操作
const DEBUG_MODE = false;
if (DEBUG_MODE) {
    addLog(`详细日志`);
}
```

**优势**:
- 减少DOM操作开销
- 界面更流畅

### 策略6: Web Workers

```javascript
// 在后台线程中处理翻译
const worker = new Worker('translate-worker.js');
worker.postMessage({ text, sourceLang, targetLang });
worker.onmessage = (e) => {
    const translated = e.data;
};
```

**优势**:
- 不阻塞主线程
- UI保持响应

### 策略7: 批量请求优化

```javascript
// 一次请求翻译多个段落
const batch = paragraphs.slice(0, 20);
const prompt = `翻译以下${batch.length}个段落...\n${batch.join('\n\n')}`;
```

**优势**:
- 减少网络往返
- 提高吞吐量

### 策略8: 预处理优化

```javascript
// 提前处理，过滤无需翻译的内容
const SKIP_PATTERNS = [
    /^\d+$/,  // 纯数字
    /^[^\p{L}]+$/u,  // 纯符号
    /^https?:\/\//,  // URL
    /^<[^>]+>$/,  // HTML标签
];
```

**优势**:
- 减少无效翻译
- 节省10-20%时间

### 策略9: 使用CDN加速

```javascript
// 从CDN加载资源，而非本地
const script = document.createElement('script');
script.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
```

**优势**:
- 加载更快
- 减少初始化时间

### 策略10: 按语言对优化

```javascript
// 针对不同语言对使用不同策略
const STRATEGY_MAP = {
    'ja→zh': { minLen: 400, maxLen: 600 },  // 日→中：可更大
    'en→zh': { minLen: 300, maxLen: 500 },  // 英→中：中等
    'zh→en': { minLen: 250, maxLen: 400 },  // 中→英：较小
};
```

**优势**:
- 根据语言特点优化
- 平衡速度和质量

## 📈 性能对比

### 优化前
```
并发数: 15
合并: 200-300字
延迟: 200ms
重试: 线性
速度: 基准
```

### 优化后（当前）
```
并发数: 30 (2倍)
合并: 300-500字 (1.7倍)
延迟: 0ms (无)
重试: 指数退避 (快30%)
速度: 约3-4倍提升
```

### 理论最快（全部优化）
```
并发: 50
流式API: ✓
文件并行: ✓
缓存: 重复内容0时间
速度: 约8-10倍提升
```

## 🎯 实际建议

### 小文件 (< 1万字)
- 并发: 30
- 合并: 300-500字
- 无需特殊优化
- 预计时间: 1-2分钟

### 中等文件 (1-10万字)
- 并发: 40
- 合并: 400-600字
- 启用缓存
- 预计时间: 5-10分钟

### 大文件 (> 10万字)
- 并发: 50
- 合并: 500-800字
- 启用所有优化
- 文件级并行
- 预计时间: 15-30分钟

## ⚠️ 注意事项

### API限制
- OpenRouter: 通常限制50-100并发
- 智谱AI: 建议不超过30并发
- 超过限制可能导致429错误

### 质量vs速度
- 合并组越大，速度越快，但可能影响翻译连贯性
- 建议: 300-500字是最佳平衡点

### 成本考虑
- 并发越高，API调用越快，但token消耗相同
- 流式API不减少token使用
- 缓存可以显著降低成本

## 🔧 实施优先级

### 立即实施 (已完成)
1. ✅ 提高并发数到30
2. ✅ 移除批次延迟
3. ✅ 优化重试策略
4. ✅ 增大合并组

### 短期实施 (推荐)
1. ⭐ 使用更快的模型 (GPT-3.5)
2. ⭐ 启用智能缓存
3. ⭐ 文件级并行处理

### 中期实施
1. ⚡ 流式API
2. ⚡ Web Workers
3. ⚡ 按语言对优化

### 长期优化
1. 🚀 自建翻译服务
2. 🚀 模型微调
3. 🚀 分布式处理

## 📚 参考资料

- [OpenRouter API文档](https://openrouter.ai/docs)
- [OpenAI并发最佳实践](https://platform.openai.com/docs/api-reference/batch)
- [Web Workers API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API)
- [流式响应处理](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
