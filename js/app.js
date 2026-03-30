// Global variables
let epubFile = null;
let epubZip = null;
let translatedEpub = null;
let isTranslating = false;
let shouldCancel = false;

// UI节流优化：减少高频DOM更新
let lastUpdateTime = 0;
const UI_UPDATE_THROTTLE = 100; // 100ms节流

// 翻译缓存：避免重复翻译相同内容
const translationCache = new Map();
const MAX_CACHE_SIZE = 1000; // 最大缓存条目数

// 节流函数：限制函数执行频率
function throttle(func, delay) {
let lastCall = 0;
return function(...args) {
const now = Date.now();
if (now - lastCall >= delay) {
lastCall = now;
return func.apply(this, args);
}
};
}

// FNV-1a 哈希：快速、低碰撞
function fnv1aHash(str) {
let hash = 0x811c9dc5; // FNV offset basis
for (let i = 0; i < str.length; i++) {
hash ^= str.charCodeAt(i);
hash = (hash * 0x01000193) >>> 0; // FNV prime, keep as uint32
}
return hash.toString(36);
}

// 缓存键生成函数
function getCacheKey(text, sourceLang, targetLang) {
return `${sourceLang}-${targetLang}-${text.length}-${fnv1aHash(text)}`;
}

// 添加到缓存
function addToCache(text, sourceLang, targetLang, result) {
if (translationCache.size >= MAX_CACHE_SIZE) {
// 清理最旧的条目（简单的FIFO）
const firstKey = translationCache.keys().next().value;
translationCache.delete(firstKey);
}
const key = getCacheKey(text, sourceLang, targetLang);
translationCache.set(key, result);
}

// 从缓存获取
function getFromCache(text, sourceLang, targetLang) {
const key = getCacheKey(text, sourceLang, targetLang);
return translationCache.get(key);
}

// ===== 性能优化全局常量 =====

// 并发信号量：控制最大并发 API 请求数，防止限流和内存峰值
function createSemaphore(maxConcurrent) {
let running = 0;
const queue = [];
return async function acquire(fn) {
if (running >= maxConcurrent) {
await new Promise(resolve => queue.push(resolve));
}
running++;
try {
return await fn();
} finally {
running--;
if (queue.length > 0) queue.shift()();
}
};
}
const translationSemaphore = createSemaphore(30); // 最大30个并发API请求

// 全局语言名称映射（替代文件中多处局部定义）
const LANG_NAMES = {
'en': '英语', 'zh': '中文', 'ja': '日语', 'ko': '韩语',
'fr': '法语', 'es': '西班牙语', 'de': '德语', 'ru': '俄语', 'pt': '葡萄牙语'
};
const LANG_CODES = {
'en': 'EN', 'zh': 'ZH', 'ja': 'JA', 'ko': 'KO',
'fr': 'FR', 'es': 'ES', 'de': 'DE', 'ru': 'RU', 'pt': 'PT'
};

// 块级元素集合（Set.has() 为 O(1)，替代多处 Array.includes() O(n) 查找）
const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
'li', 'td', 'th', 'blockquote', 'article', 'section', 'header', 'footer',
'aside', 'main', 'nav', 'figure', 'figcaption', 'caption', 'address', 'pre',
'dl', 'dt', 'dd']);

// 日志队列（RAF批量刷新，减少DOM操作频次）
const _logQueue = [];
let _logRafId = null;

// ===== 翻译质量模式与术语表 =====

// 获取当前翻译质量模式
function getTranslationMode() {
return document.querySelector('input[name="translationMode"]:checked')?.value || 'standard';
}

// 解析用户自定义术语表
function parseGlossary() {
const glossaryText = document.getElementById('customGlossary')?.value || '';
if (!glossaryText.trim()) return null;
const entries = [];
for (const line of glossaryText.split('\n')) {
const trimmed = line.trim();
if (!trimmed || trimmed.startsWith('#')) continue;
const sep = trimmed.indexOf('=');
if (sep > 0) {
const source = trimmed.substring(0, sep).trim();
const target = trimmed.substring(sep + 1).trim();
if (source && target) entries.push({ source, target });
}
}
return entries.length > 0 ? entries : null;
}

// 构建术语表提示文本
function buildGlossaryText(glossary) {
if (!glossary || glossary.length === 0) return '';
const lines = glossary.map(g => `  - ${g.source} → ${g.target}`).join('\n');
return `\n术语表（请严格遵循以下翻译）：\n${lines}\n`;
}

// 构建批量翻译的 system prompt（根据质量模式）
function buildBatchSystemPrompt(sourceLang, targetLang, mode) {
const glossary = parseGlossary();
const glossaryText = buildGlossaryText(glossary);
const sourceName = LANG_NAMES[sourceLang];
const targetName = LANG_NAMES[targetLang];

if (mode === 'quick') {
  return `你是${sourceName}到${targetName}的翻译专家。请准确翻译用户提供的文本。只返回译文，不要有任何解释。${glossaryText}`;
}

if (mode === 'refined') {
  return `你是一位资深的${sourceName}到${targetName}翻译专家，同时也是出色的${targetName}作家。

你的核心原则是「重写而非直译」——将内容用自然、地道、流畅的${targetName}重新表达，如同${targetName}母语作者撰写。

翻译要求：
1. 准确性：忠实传达原文的事实、逻辑和意图，不遗漏、不添加信息
2. 地道表达：使用${targetName}的惯用语序、搭配和表达方式，避免翻译腔
3. 风格一致：保持原文的语气、风格和文学性（如幽默、正式、口语化等）
4. 术语处理：专业术语首次出现时可在括号内注明原文（如：强化学习(Reinforcement Learning)）
5. 文化适配：必要时对文化背景、典故进行适当本地化处理
6. 格式保持：严格保留原文的段落结构、HTML标签和格式标记
${glossaryText}
翻译后，请自我审校一遍：检查是否有漏译、误译、不通顺之处，确保译文自然流畅。`;
}

// standard mode (default)
return `你是一位专业的${sourceName}到${targetName}翻译专家。

核心原则：「重写而非直译」——产出自然地道的${targetName}文本，如同母语写作。

翻译要求：
1. 忠实传达原文含义，不遗漏、不添加
2. 使用${targetName}惯用的语序和表达方式，避免翻译腔
3. 保持原文的语气和风格
4. 专有名词保留原文或音译
5. 严格保留原文的段落结构和HTML标签
${glossaryText}`;
}

// 构建单段重试的 system prompt
function buildSingleRetrySystemPrompt(sourceLang, targetLang) {
const glossary = parseGlossary();
const glossaryText = buildGlossaryText(glossary);
const sourceName = LANG_NAMES[sourceLang];
const targetName = LANG_NAMES[targetLang];

return `你是${sourceName}到${targetName}的翻译专家。核心原则：重写而非直译，产出自然地道的${targetName}文本。${glossaryText}`;
}

// 构建批量翻译的 user prompt
function buildBatchUserPrompt(originalText, paraCount, mode) {
if (mode === 'quick') {
  return `翻译以下${paraCount}个段落，每段之间空一行，必须返回恰好${paraCount}个段落，只返回译文：

${originalText}

译文：`;
}

if (mode === 'refined') {
  return `请翻译以下${paraCount}个段落。

格式要求：
1. 每个段落翻译后空一行（输入两个回车）
2. 必须返回恰好${paraCount}个翻译段落
3. 只返回译文，不要有任何解释或注释

翻译步骤：
- 先理解每段的核心含义和语境
- 用目标语言重新表达，确保自然流畅
- 审校检查：是否通顺、有无漏译

原文：
${originalText}

译文：`;
}

// standard
return `请翻译以下${paraCount}个段落，译文格式要求：

1. 每个段落翻译后空一行（输入两个回车）
2. 必须返回恰好${paraCount}个翻译段落
3. 只返回译文，不要有任何解释
4. 专有名词可保留原文或音译

原文：
${originalText}

译文：`;
}

// 构建单段重试的 user prompt
function buildSingleRetryUserPrompt(originalText, sourceLang, targetLang) {
return `请将以下${LANG_NAMES[sourceLang]}文本翻译成${LANG_NAMES[targetLang]}。

原文：
${originalText}

要求：
1. 准确翻译所有内容，包括任何英文单词、数字、专有名词
2. 用自然地道的${LANG_NAMES[targetLang]}重新表达，避免翻译腔
3. 只返回翻译结果，不要添加任何解释、前言或后记
4. 绝对禁止添加"Excerpt From"、版权声明、元数据等任何内容`;
}

// 更新翻译模式描述文本
function updateModeDescription() {
const mode = getTranslationMode();
const desc = document.getElementById('modeDescription');
if (!desc) return;
const descriptions = {
  'quick': '快速模式：直接翻译，不做额外分析，速度最快，适合对质量要求不高的场景。',
  'standard': '标准模式：采用「重写而非直译」策略，产出自然地道的目标语言文本。',
  'refined': '精翻模式：翻译后自动审校，检查漏译、误译和不通顺之处，质量最高但速度较慢。'
};
desc.textContent = descriptions[mode] || descriptions['standard'];
}

// ===== 性能优化全局常量结束 =====

// Multi-file handling
let translatedEpubList = [];
let isBatchMode = false;
let currentBatchIndex = 0;
let totalBatchFiles = 0;

// File list management
let fileListData = [];  // 存储所有文件的信息

// Token tracking variables
let totalInputTokens = 0;
let totalOutputTokens = 0;
let totalSourceChars = 0;  // 原文总字数
let totalTranslatedChars = 0;  // 译文总字数

// Vertical mode detection
let isVerticalMode = false;

// Detected language from file content (for validation)
let detectedSourceLangCode = null;

// Translation progress tracking
let totalCharsToTranslate = 0;
let translatedChars = 0;
let translationStartTime = null;
let translationEndTime = null;
let timeUpdateInterval = null; // 实时更新时长的定时器

// Preview state
let previewPages = [];
let currentPreviewPage = 0;

// DOM Elements (将在 DOMContentLoaded 中初始化)
let dropZone = null;
let fileInput = null;
let fileInfo = null;
let fileName = null;
let fileSize = null;
let removeFile = null;
let translateBtn = null;
let cancelBtn = null;
let progressArea = null;
let progressStatus = null;
let progressPercent = null;
let progressBar = null;
let progressLog = null;
let originalTextDiv = null;
let translatedTextDiv = null;
let downloadArea = null;
let downloadBtn = null;
let translationService = null;
let customApiSettings = null;

// Initialize DOM Elements
function initializeDOMElements() {
dropZone = document.getElementById('dropZone');
fileInput = document.getElementById('fileInput');
fileInfo = document.getElementById('fileInfo');
fileName = document.getElementById('fileName');
fileSize = document.getElementById('fileSize');
removeFile = document.getElementById('removeFile');
translateBtn = document.getElementById('translateBtn');
cancelBtn = document.getElementById('cancelBtn');
progressArea = document.getElementById('progressArea');
progressStatus = document.getElementById('progressStatus');
progressPercent = document.getElementById('progressPercent');
progressBar = document.getElementById('progressBar');
progressLog = document.getElementById('progressLog');
originalTextDiv = document.getElementById('originalText');
translatedTextDiv = document.getElementById('translatedText');
downloadArea = document.getElementById('downloadArea');
downloadBtn = document.getElementById('downloadBtn');
translationService = document.getElementById('translationService');
customApiSettings = document.getElementById('customApiSettings');
}

// File list rendering
function renderFileList() {
const fileListContainer = document.getElementById('fileListContainer');
const fileList = document.getElementById('fileList');
const fileListSummary = document.getElementById('fileListSummary');

if (!fileListData || fileListData.length === 0) {
fileListContainer.classList.add('hidden');
return;
}

// 显示文件列表
fileListContainer.classList.remove('hidden');

// 更新摘要
fileListSummary.textContent = `共 ${fileListData.length} 个文件`;

// 清空列表
fileList.innerHTML = '';

// 渲染每个文件
fileListData.forEach((fileInfo, index) => {
const fileItem = document.createElement('div');
fileItem.className = 'file-item p-3 bg-gray-50 rounded-lg border border-gray-200';
fileItem.id = `fileItem_${index}`;

// 状态图标和颜色
const statusConfig = {
'pending': { icon: '⏳', color: 'text-gray-600', bg: 'bg-gray-100', text: '待处理' },
'processing': { icon: '⏳', color: 'text-blue-600', bg: 'bg-blue-100', text: '处理中' },
'completed': { icon: '✓', color: 'text-green-600', bg: 'bg-green-100', text: '已完成' },
'failed': { icon: '✗', color: 'text-red-600', bg: 'bg-red-100', text: '失败' }
};

const status = statusConfig[fileInfo.status] || statusConfig['pending'];

// 安全构建DOM元素，防止XSS攻击
const flexContainer = document.createElement('div');
flexContainer.className = 'flex items-center justify-between';

const leftSection = document.createElement('div');
leftSection.className = 'flex items-center flex-1';

const iconContainer = document.createElement('div');
iconContainer.className = `${status.bg} rounded-full p-2 mr-3`;
const iconSpan = document.createElement('span');
iconSpan.className = 'text-lg';
iconSpan.textContent = status.icon;
iconContainer.appendChild(iconSpan);

const infoContainer = document.createElement('div');
infoContainer.className = 'flex-1';

const nameP = document.createElement('p');
nameP.className = 'font-medium text-gray-800';
nameP.textContent = fileInfo.name; // 使用 textContent 避免 XSS

const sizeP = document.createElement('p');
sizeP.className = 'text-sm text-gray-500';
sizeP.textContent = formatFileSize(fileInfo.size);

infoContainer.appendChild(nameP);
infoContainer.appendChild(sizeP);
leftSection.appendChild(iconContainer);
leftSection.appendChild(infoContainer);

const rightSection = document.createElement('div');
rightSection.className = 'text-right flex items-center gap-3';

const statusSpan = document.createElement('span');
statusSpan.className = `${status.color} text-sm font-medium`;
statusSpan.textContent = status.text;
rightSection.appendChild(statusSpan);

if (fileInfo.progress) {
const progressP = document.createElement('p');
progressP.className = 'text-xs text-gray-400 mt-1';
progressP.textContent = fileInfo.progress;
rightSection.appendChild(progressP);
}

// 添加删除按钮
const deleteBtn = document.createElement('button');
deleteBtn.className = 'text-red-500 hover:text-red-700 p-1 rounded hover:bg-red-50 transition-colors';
deleteBtn.title = '删除此文件';
deleteBtn.innerHTML = `<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
</svg>`;
deleteBtn.onclick = () => deleteFile(index);
rightSection.appendChild(deleteBtn);

flexContainer.appendChild(leftSection);
flexContainer.appendChild(rightSection);
fileItem.appendChild(flexContainer);

fileList.appendChild(fileItem);
});
}

function updateFileStatus(index, status, progress = null) {
if (index >= 0 && index < fileListData.length) {
fileListData[index].status = status;
if (progress) {
fileListData[index].progress = progress;
}
renderFileList();
}
}

// 删除文件
function deleteFile(index) {
if (index < 0 || index >= fileListData.length) {
return;
}

const fileToDelete = fileListData[index];

// 确认删除
const confirmed = confirm(`确定要删除文件 "${fileToDelete.name}" 吗？`);
if (!confirmed) {
return;
}

// 从列表中删除
fileListData.splice(index, 1);

// 如果删除的是第一个文件，需要重置解析状态
if (index === 0) {
epubFile = null;
epubZip = null;
detectedSourceLangCode = null;

// 重置文件详情显示
document.getElementById('wordCount').textContent = '-';
document.getElementById('detectedLang').textContent = '-';
document.getElementById('textFileCount').textContent = '-';

// 隐藏竖排转换选项
const verticalConvertOption = document.getElementById('verticalConvertOption');
if (verticalConvertOption) {
verticalConvertOption.classList.add('hidden');
}
}

// 如果列表为空，禁用翻译按钮
if (fileListData.length === 0) {
translateBtn.disabled = true;
// 隐藏文件列表容器
const fileListContainer = document.getElementById('fileListContainer');
if (fileListContainer) {
fileListContainer.classList.add('hidden');
}
} else {
// 如果还有文件，重新解析第一个文件（如果是删除了第一个文件）
if (index === 0 && fileListData.length > 0) {
const newFirstFile = fileListData[0].fileObject;
if (newFirstFile) {
processFile(newFirstFile);
}
}
}

// 重新渲染列表
renderFileList();

addLog(`已删除文件: ${fileToDelete.name}`);
}

// LocalStorage functions
const STORAGE_KEY = 'epub-translator-config';

function saveConfig() {
const config = {
sourceLang: document.querySelector('input[name="sourceLang"]:checked')?.value || 'en',
targetLang: document.querySelector('input[name="targetLang"]:checked')?.value || 'zh',
translationService: translationService.value,
zhipuApiKey: document.getElementById('zhipuApiKey')?.value || '',
zhipuBaseUrl: document.getElementById('zhipuBaseUrl')?.value || 'https://open.bigmodel.cn/api/paas/v4/',
openrouterApiKey: document.getElementById('openrouterApiKey')?.value || '',
openrouterModel: document.getElementById('openrouterModel')?.value || 'deepseek/deepseek-chat',
customEndpoint: document.getElementById('apiEndpoint')?.value || '',
customApiKey: document.getElementById('apiKey')?.value || '',
translationMode: getTranslationMode(),
customGlossary: document.getElementById('customGlossary')?.value || ''
};
localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

function loadConfig() {
try {
const saved = localStorage.getItem(STORAGE_KEY);
if (saved) {
const config = JSON.parse(saved);

// 恢复源语言选择
if (config.sourceLang) {
const sourceRadio = document.querySelector(`input[name="sourceLang"][value="${config.sourceLang}"]`);
if (sourceRadio) sourceRadio.checked = true;
}

// 恢复目标语言选择
if (config.targetLang) {
const targetRadio = document.querySelector(`input[name="targetLang"][value="${config.targetLang}"]`);
if (targetRadio) targetRadio.checked = true;
}

// 恢复翻译服务选择
if (config.translationService) {
translationService.value = config.translationService;
handleServiceChange();
}

// 恢复智谱AI配置
if (config.zhipuApiKey) {
const zhipuKeyInput = document.getElementById('zhipuApiKey');
if (zhipuKeyInput) zhipuKeyInput.value = config.zhipuApiKey;
}
if (config.zhipuBaseUrl) {
const zhipuUrlInput = document.getElementById('zhipuBaseUrl');
if (zhipuUrlInput) zhipuUrlInput.value = config.zhipuBaseUrl;
}

// 恢复OpenRouter配置
if (config.openrouterApiKey) {
const openrouterKeyInput = document.getElementById('openrouterApiKey');
if (openrouterKeyInput) openrouterKeyInput.value = config.openrouterApiKey;
}
if (config.openrouterModel) {
const openrouterModelInput = document.getElementById('openrouterModel');
if (openrouterModelInput) openrouterModelInput.value = config.openrouterModel;
}

// 恢复自定义API配置
if (config.customEndpoint) {
const endpointInput = document.getElementById('apiEndpoint');
if (endpointInput) endpointInput.value = config.customEndpoint;
}
if (config.customApiKey) {
const apiKeyInput = document.getElementById('apiKey');
if (apiKeyInput) apiKeyInput.value = config.customApiKey;
}

// 恢复翻译质量模式
if (config.translationMode) {
const modeRadio = document.querySelector(`input[name="translationMode"][value="${config.translationMode}"]`);
if (modeRadio) {
modeRadio.checked = true;
updateModeDescription();
}
}

// 恢复术语表
if (config.customGlossary) {
const glossaryInput = document.getElementById('customGlossary');
if (glossaryInput) glossaryInput.value = config.customGlossary;
}

addLog('已恢复上次的配置');
}
} catch (error) {
console.error('加载配置失败:', error);
}
}


document.addEventListener('DOMContentLoaded', function() {
initializeDOMElements();
loadConfig();

// 绑定文件上传相关事件监听器
dropZone.addEventListener('click', () => fileInput.click());
// 添加拖放事件监听器
dropZone.addEventListener('dragover', handleDragOver);
dropZone.addEventListener('dragleave', handleDragLeave);
dropZone.addEventListener('drop', handleDrop);
fileInput.addEventListener('change', handleFileSelect);
removeFile.addEventListener('click', handleRemoveFile);
translateBtn.addEventListener('click', handleTranslate);
cancelBtn.addEventListener('click', handleCancel);
downloadBtn.addEventListener('click', handleDownload);

// 绑定批量下载所有文件按钮
const downloadAllBtn = document.getElementById('downloadAllBtn');
if (downloadAllBtn) {
downloadAllBtn.addEventListener('click', handleDownload);
}

translationService.addEventListener('change', handleServiceChange);

// 绑定复制日志按钮
const copyLogBtn = document.getElementById('copyLogBtn');
if (copyLogBtn) {
copyLogBtn.addEventListener('click', function() {
const logContent = progressLog.textContent || progressLog.innerText;
if (logContent.trim()) {
// 使用 Clipboard API 复制
navigator.clipboard.writeText(logContent).then(function() {
// 复制成功，临时更改按钮文本
const originalHTML = copyLogBtn.innerHTML;
copyLogBtn.innerHTML = `
<svg class="h-4 w-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
</svg>
已复制！
`;
copyLogBtn.classList.remove('bg-gray-200', 'hover:bg-gray-300');
copyLogBtn.classList.add('bg-green-500', 'hover:bg-green-600', 'text-white');

// 2秒后恢复原样
setTimeout(function() {
copyLogBtn.innerHTML = originalHTML;
copyLogBtn.classList.remove('bg-green-500', 'hover:bg-green-600', 'text-white');
copyLogBtn.classList.add('bg-gray-200', 'hover:bg-gray-300');
}, 2000);
}).catch(function(err) {
// 复制失败，显示错误
console.error('复制失败:', err);
alert('复制失败，请手动选择日志内容复制');
});
} else {
// 日志为空时的提示
alert('日志内容为空');
}
});
}

// 绑定清空列表按钮
const clearFileListBtnEl = document.getElementById('clearFileList');
if (clearFileListBtnEl) {
clearFileListBtnEl.addEventListener('click', clearFileListBtn);
}

// 预览功能初始化
const previewBtn = document.getElementById('previewBtn');
const closePreviewBtn = document.getElementById('closePreview');
const prevPageBtn = document.getElementById('prevPage');
const nextPageBtn = document.getElementById('nextPage');

if (previewBtn) {
previewBtn.addEventListener('click', showPreview);
}
if (closePreviewBtn) {
closePreviewBtn.addEventListener('click', closePreview);
}
if (prevPageBtn) {
prevPageBtn.addEventListener('click', prevPreviewPage);
}
if (nextPageBtn) {
nextPageBtn.addEventListener('click', nextPreviewPage);
}

// 点击模态框背景关闭
const previewModal = document.getElementById('previewModal');
if (previewModal) {
previewModal.addEventListener('click', function(e) {
if (e.target === previewModal) {
closePreview();
}
});
}

// 监听语言选择变化，自动保存配置
document.querySelectorAll('input[name="sourceLang"]').forEach(radio => {
    radio.addEventListener('change', saveConfig);
});
document.querySelectorAll('input[name="targetLang"]').forEach(radio => {
    radio.addEventListener('change', saveConfig);
});

// 监听API配置变化，自动保存
const zhipuKeyInput = document.getElementById('zhipuApiKey');
const zhipuUrlInput = document.getElementById('zhipuBaseUrl');
const openrouterKeyInput = document.getElementById('openrouterApiKey');
const openrouterModelInput = document.getElementById('openrouterModel');
const openrouterModelInput2 = document.getElementById('openrouterModel');
const customEndpointInput = document.getElementById('apiEndpoint');
const customApiKeyInput = document.getElementById('apiKey');

if (zhipuKeyInput) zhipuKeyInput.addEventListener('input', saveConfig);
if (zhipuUrlInput) zhipuUrlInput.addEventListener('input', saveConfig);
if (openrouterKeyInput) openrouterKeyInput.addEventListener('input', saveConfig);
if (openrouterModelInput2) openrouterModelInput2.addEventListener('change', saveConfig);
if (customEndpointInput) customEndpointInput.addEventListener('input', saveConfig);
if (customApiKeyInput) customApiKeyInput.addEventListener('input', saveConfig);

// 监听翻译质量模式变化
document.querySelectorAll('input[name="translationMode"]').forEach(radio => {
    radio.addEventListener('change', function() {
        updateModeDescription();
        saveConfig();
    });
});

// 监听术语表变化
const glossaryInput = document.getElementById('customGlossary');
if (glossaryInput) glossaryInput.addEventListener('input', saveConfig);
});
// Event Listeners will be initialized after DOMContentLoaded

// 清空文件列表按钮
function clearFileListBtn() {
if (confirm('确定要清空文件列表吗？')) {
fileListData = [];
renderFileList();
addLog('文件列表已清空');
}
}

// 更新对比窗口（带节流优化）
function updateComparisonWindow(original, translated) {
const now = Date.now();
if (now - lastUpdateTime < UI_UPDATE_THROTTLE) {
return; // 跳过过于频繁的更新
}
lastUpdateTime = now;

if (originalTextDiv && translatedTextDiv) {
originalTextDiv.textContent = original || '...';
translatedTextDiv.textContent = translated || '翻译中...';
}
}

// 取消翻译
function handleCancel() {
if (isTranslating) {
shouldCancel = true;
addLog('⚠️ 正在取消翻译...', true);
cancelBtn.disabled = true;
cancelBtn.textContent = '取消中...';
}
}

function handleDragLeave(e) {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
}

function handleDragOver(e) {
    e.preventDefault();
    dropZone.classList.add('drag-over');
}

function handleDrop(e) {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const files = e.dataTransfer.files;
    if (files.length > 0) {
        // Handle as file select for multi-file support
        handleFileSelect({ target: { files: files } });
    }
}

function handleFileSelect(e) {
const files = Array.from(e.target.files).filter(f => f.name.endsWith('.epub'));
if (files.length > 0) {
// 合并新选择的文件到现有列表（避免重复）
const newFileInfos = files.map(file => ({
name: file.name,
size: file.size,
status: 'pending',
progress: null,
fileObject: file  // 保存原始文件对象
}));

// 检查并合并文件（通过文件名和大小判断重复）
const mergedFiles = [...fileListData];
newFileInfos.forEach(newFile => {
const exists = mergedFiles.some(existing =>
existing.name === newFile.name && existing.size === newFile.size
);
if (!exists) {
mergedFiles.push(newFile);
}
});

fileListData = mergedFiles;

// 如果是第一个文件，解析它并分析内容
if (fileListData.length === 1 && fileListData[0].fileObject) {
const firstFile = fileListData[0].fileObject;
processFile(firstFile);
} else if (fileListData.length > 1) {
// 多个文件：启用翻译按钮，使用第一个文件的配置信息
translateBtn.disabled = false;
// 如果第一个文件已经解析过，保持显示其信息
// 否则解析第一个文件以显示配置信息
if (!epubZip && fileListData[0].fileObject) {
processFile(fileListData[0].fileObject);
}
}

// 清空单文件显示区域（因为现在使用列表显示）
fileInfo.classList.add('hidden');

// 显示文件列表
renderFileList();

// 清空文件输入，允许重复选择同一文件
fileInput.value = '';
}
}

// 批量处理多个EPUB文件（保持串行，但内部并发优化）
async function processMultipleFiles(files, sourceLang, targetLang, service) {
// 不调用 resetAllData()，因为UI状态已经在 handleTranslate 中设置好了
// 只重置必要的数据
epubFile = null;
epubZip = null;
translatedEpub = null;

// 初始化批量处理状态
isBatchMode = true;
totalBatchFiles = files.length;
translatedEpubList = [];

// 保存批量翻译前的累积统计数据（用于恢复）
const savedTotalSourceChars = totalSourceChars;
const savedTotalTranslatedChars = totalTranslatedChars;
const savedInputTokens = totalInputTokens;
const savedOutputTokens = totalOutputTokens;

// 显示批量处理信息
const batchInfo = document.getElementById('batchInfo');
if (batchInfo) {
batchInfo.classList.remove('hidden');
document.getElementById('totalFiles').textContent = files.length;
}

addLog(`开始批量处理 ${files.length} 个EPUB文件（优化版）`);

// 依次处理每个文件（内部已优化并发）
for (let i = 0; i < files.length; i++) {
currentBatchIndex = i;
const file = files[i];

// 更新批量处理计数器
if (batchInfo) {
document.getElementById('currentIndex').textContent = i + 1;
}

// 更新文件列表状态：处理中
updateFileStatus(i, 'processing');
addLog(`[${i + 1}/${files.length}] 正在处理: ${file.name}`);

try {
// 处理当前文件
await processFile(file);

// 为当前文件重置字数统计（但保持token累积）
totalCharsToTranslate = 0;
translatedChars = 0;
totalSourceChars = 0; // 重置原文统计，避免累积

// 执行翻译（这是关键！）
await translateCurrentFile(sourceLang, targetLang, service);

// 保存翻译结果
if (translatedEpub) {
translatedEpubList.push({
file: file,
translatedEpub: translatedEpub,
fileName: file.name
});
// 更新文件列表状态：已完成
updateFileStatus(i, 'completed');
addLog(`  -> ✓ ${file.name} 处理完成`);
}
} catch (error) {
// 更新文件列表状态：失败
updateFileStatus(i, 'failed', error.message);
addLog(`  -> ✗ ${file.name} 处理失败: ${error.message}`, true);
}

// 重置状态以准备下一个文件
if (i < files.length - 1) {
// 不是最后一个文件，重置部分状态
epubFile = null;
epubZip = null;
translatedEpub = null;
// 重置当前文件的字数统计，但保持token累积
totalCharsToTranslate = 0;
translatedChars = 0;
}
}

addLog(`✓ 批量处理完成！共处理 ${translatedEpubList.length} 个文件`);

// 渲染翻译结果列表
renderTranslatedFileList();

// 翻译完成后，显示下载按钮
downloadArea.classList.remove('hidden');
translateBtn.disabled = false;
translateBtn.classList.remove('hidden');
cancelBtn.classList.add('hidden');
isTranslating = false;
isBatchMode = false;
stopTimeUpdate(); // 停止实时时长更新
}

// 渲染翻译后的文件列表
function renderTranslatedFileList() {
const listContainer = document.getElementById('translatedFileList');
const singleFileDiv = document.getElementById('singleFileDownload');
const batchFileDiv = document.getElementById('batchFileDownload');

if (!listContainer) return;

// 显示批量模式，隐藏单文件模式
if (singleFileDiv) singleFileDiv.classList.add('hidden');
if (batchFileDiv) batchFileDiv.classList.remove('hidden');

// 清空列表
listContainer.innerHTML = '';

// 获取语言信息
const sourceLang = document.querySelector('input[name="sourceLang"]:checked').value;
const targetLang = document.querySelector('input[name="targetLang"]:checked').value;

// 为每个文件创建列表项
translatedEpubList.forEach((fileData, index) => {
const fileItem = document.createElement('div');
fileItem.className = 'bg-white border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow';

// 生成文件名
const originalName = fileData.fileName.replace('.epub', '');
const displayName = `${originalName} (${LANG_NAMES[sourceLang]}→${LANG_NAMES[targetLang]})`;

fileItem.innerHTML = `
<div class="flex items-center justify-between">
<div class="flex items-center flex-1">
<div class="bg-green-100 rounded-full p-2 mr-3">
<svg class="h-5 w-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
</svg>
</div>
<div class="flex-1">
<p class="font-medium text-gray-800">${displayName}</p>
<p class="text-sm text-gray-500">已完成翻译</p>
</div>
</div>
<div class="flex items-center gap-2">
<button onclick="previewTranslatedFile(${index})" class="bg-blue-500 text-white px-4 py-2 rounded-lg hover:bg-blue-600 transition-colors text-sm font-medium">
<span class="flex items-center">
<svg class="h-4 w-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path>
</svg>
预览
</span>
</button>
<button onclick="downloadTranslatedFile(${index})" class="bg-green-500 text-white px-4 py-2 rounded-lg hover:bg-green-600 transition-colors text-sm font-medium">
<span class="flex items-center">
<svg class="h-4 w-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path>
</svg>
下载
</span>
</button>
</div>
</div>
`;

listContainer.appendChild(fileItem);
});
}

// 预览指定的翻译文件
async function previewTranslatedFile(index) {
try {
const fileData = translatedEpubList[index];
if (!fileData || !fileData.translatedEpub) {
alert('文件未找到或翻译未完成');
return;
}

// 临时设置当前翻译结果为预览的文件
const tempTranslatedEpub = translatedEpub;
translatedEpub = fileData.translatedEpub;

// 使用原有的预览功能
await showPreview();

// 恢复原翻译结果
translatedEpub = tempTranslatedEpub;

// 显示预览模态框
const modal = document.getElementById('previewModal');
if (modal) modal.classList.remove('hidden');

} catch (error) {
console.error('预览失败:', error);
alert('预览失败: ' + error.message);
}
}

// 下载指定的翻译文件
async function downloadTranslatedFile(index) {
try {
const fileData = translatedEpubList[index];
if (!fileData || !fileData.translatedEpub) {
alert('文件未找到或翻译未完成');
return;
}

// 获取语言信息
const sourceLang = document.querySelector('input[name="sourceLang"]:checked').value;
const targetLang = document.querySelector('input[name="targetLang"]:checked').value;

// 生成文件名
const originalName = fileData.fileName.replace('.epub', '');
const newName = `${originalName}_${LANG_CODES[sourceLang]}to${LANG_CODES[targetLang]}_translated.epub`;

// 生成并下载
const content = await fileData.translatedEpub.generateAsync({ type: 'blob' });
const url = URL.createObjectURL(content);
const a = document.createElement('a');
a.href = url;
a.download = newName;
document.body.appendChild(a);
a.click();
document.body.removeChild(a);
URL.revokeObjectURL(url);

addLog(`✓ 已下载: ${newName}`);

} catch (error) {
console.error('下载失败:', error);
alert('下载失败: ' + error.message);
}
}

async function processFile(file) {
if (!file.name.endsWith('.epub')) {
alert('请上传 .epub 格式的文件');
return;
}

// 只有在非批量模式下才重置数据和UI状态
if (!isBatchMode) {
// 清空之前的数据
resetAllData();

epubFile = file;
fileName.textContent = file.name;
fileSize.textContent = formatFileSize(file.size);
fileInfo.classList.remove('hidden');
translateBtn.disabled = false;
} else {
// 批量模式：只重置必要的数据，不修改UI
epubFile = file;
}

// Parse EPUB
await parseEpub(file);

// 分析文件内容
await analyzeEpubContent();
}

// 翻译当前已解析的文件
async function translateCurrentFile(sourceLang, targetLang, service) {
if (!epubZip) {
throw new Error('EPUB文件未解析，请先调用 processFile()');
}

addLog('开始翻译当前文件...');

try {
// 统计总字数
const files = Object.keys(epubZip.files);
for (const filename of files) {
if (filename.endsWith('.html') || filename.endsWith('.xhtml')) {
const file = epubZip.files[filename];
if (!file.dir) {
const content = await file.async('string');
const parser = new DOMParser();
const doc = parser.parseFromString(content, 'text/html');
const text = doc.body.textContent || '';
const charCount = text.trim().replace(/\s+/g, '').length;
totalCharsToTranslate += charCount;
}
}
}

addLog(`总字数: ${totalCharsToTranslate.toLocaleString()} 字`);

// Create new zip for translated content
translatedEpub = new JSZip();

// Copy all files
let processedFiles = 0;

for (const filename of files) {
// 检查是否需要取消
if (shouldCancel) {
addLog('⚠️ 翻译已取消', true);
throw new Error('翻译已取消');
}

const file = epubZip.files[filename];

if (!file.dir) {
const content = await file.async('arraybuffer');

if (filename.endsWith('.html') || filename.endsWith('.xhtml')) {
// Translate HTML content
updateProgress(`正在翻译: ${filename}`, (translatedChars / totalCharsToTranslate) * 100);
addLog(`处理文件: ${filename}`);

const textContent = new TextDecoder().decode(content);
const translatedText = await translateText(textContent, sourceLang, targetLang, service);

// 更新已翻译字数
const parser = new DOMParser();
const doc = parser.parseFromString(textContent, 'text/html');
const text = doc.body.textContent || '';
const charCount = text.trim().replace(/\s+/g, '').length;
translatedChars += charCount;
updateTokenDisplay();

// 检查是否取消
if (shouldCancel) {
addLog('⚠️ 翻译已取消', true);
throw new Error('翻译已取消');
}

await translatedEpub.file(filename, translatedText);

// 验证翻译后的内容
const translatedParser = new DOMParser();
const translatedDoc = translatedParser.parseFromString(translatedText, 'text/html');
const translatedBodyText = translatedDoc.body.textContent || '';
const translatedBodyLength = translatedBodyText.trim().length;
const translatedInnerLength = translatedDoc.body.innerHTML.trim().length;

// 检查内容是否真正为空（包括SVG等非文本元素）
if (translatedBodyLength === 0 && translatedInnerLength === 0) {
addLog(`⚠️ 警告: ${filename} 翻译后内容为空！`, true);
} else if (translatedBodyLength === 0 && translatedInnerLength > 0) {
// 有HTML内容但没有文本（如SVG），这是正常的
addLog(`  -> ✓ 翻译完成（仅包含非文本内容，如SVG/图片）`);
} else {
addLog(`  -> ✓ 翻译完成，内容长度: ${translatedBodyLength} 字`);
}

// 更新进度显示
const progress = Math.round((translatedChars / totalCharsToTranslate) * 100);
updateProgress(`翻译中... ${translatedChars.toLocaleString()}/${totalCharsToTranslate.toLocaleString()} 字 (${progress}%)`, progress);
addLog(`进度: ${translatedChars.toLocaleString()}/${totalCharsToTranslate.toLocaleString()} 字 (${progress}%)`);
} else if (filename.endsWith('.opf')) {
// 处理OPF文件（元数据）
addLog(`处理元数据: ${filename}`);

let opfContent = new TextDecoder().decode(content);

// 检查并转换OPF中的页面方向属性
const convertCheckbox = document.getElementById('convertToHorizontal');
if (convertCheckbox && convertCheckbox.checked) {
addLog(`  -> 检查OPF文件中的页面方向...`);

// 转换page-progression-direction属性（多种引号格式）
const opfPageProgressionDouble = (opfContent.match(/page-progression-direction\s*=\s*"rtl"/gi) || []).length;
const opfPageProgressionSingle = (opfContent.match(/page-progression-direction\s*=\s*'rtl'/gi) || []).length;
const opfPageProgressionNoQuote = (opfContent.match(/page-progression-direction\s*=\s*rtl(?!\w)/gi) || []).length;
const totalPageProgression = opfPageProgressionDouble + opfPageProgressionSingle + opfPageProgressionNoQuote;

if (totalPageProgression > 0) {
if (opfPageProgressionDouble > 0) {
opfContent = opfContent.replace(
/page-progression-direction\s*=\s*"rtl"/gi,
'page-progression-direction="ltr"'
);
}
if (opfPageProgressionSingle > 0) {
opfContent = opfContent.replace(
/page-progression-direction\s*=\s*'rtl'/gi,
"page-progression-direction='ltr'"
);
}
if (opfPageProgressionNoQuote > 0) {
opfContent = opfContent.replace(
/page-progression-direction\s*=\s*rtl(?!\w)/gi,
'page-progression-direction="ltr"'
);
}
addLog(`  -> ✓ 转换page-progression-direction属性: ${totalPageProgression} 个`);
}
}

await translatedEpub.file(filename, opfContent);
addLog(`  -> ✓ 元数据处理完成`);
} else if (filename.endsWith('.ncx')) {
// 处理NCX文件（目录）
addLog(`处理目录: ${filename}`);

let ncxContent = new TextDecoder().decode(content);

// 检查并转换NCX中的页面方向属性
const convertCheckbox = document.getElementById('convertToHorizontal');
if (convertCheckbox && convertCheckbox.checked) {
addLog(`  -> 检查NCX文件中的页面方向...`);

// 转换page-progression-direction属性
const ncxPageProgressionDouble = (ncxContent.match(/page-progression-direction\s*=\s*"rtl"/gi) || []).length;
const ncxPageProgressionSingle = (ncxContent.match(/page-progression-direction\s*=\s*'rtl'/gi) || []).length;
const ncxPageProgressionNoQuote = (ncxContent.match(/page-progression-direction\s*=\s*rtl(?!\w)/gi) || []).length;
const totalPageProgression = ncxPageProgressionDouble + ncxPageProgressionSingle + ncxPageProgressionNoQuote;

if (totalPageProgression > 0) {
if (ncxPageProgressionDouble > 0) {
ncxContent = ncxContent.replace(
/page-progression-direction\s*=\s*"rtl"/gi,
'page-progression-direction="ltr"'
);
}
if (ncxPageProgressionSingle > 0) {
ncxContent = ncxContent.replace(
/page-progression-direction\s*=\s*'rtl'/gi,
"page-progression-direction='ltr'"
);
}
if (ncxPageProgressionNoQuote > 0) {
ncxContent = ncxContent.replace(
/page-progression-direction\s*=\s*rtl(?!\w)/gi,
'page-progression-direction="ltr"'
);
}
addLog(`  -> ✓ 转换page-progression-direction属性: ${totalPageProgression} 个`);
}
}

await translatedEpub.file(filename, ncxContent);
addLog(`  -> ✓ 目录处理完成`);
} else {
// Copy other files as-is
await translatedEpub.file(filename, content);
}
}

processedFiles++;
}

updateProgress('完成', 100);
addLog('✓ 翻译完成！');

// 更新文件列表状态（单文件模式）
if (fileListData.length > 0) {
	updateFileStatus(0, 'completed');
}

// Show download button - 单文件模式
const singleFileDiv = document.getElementById('singleFileDownload');
const batchFileDiv = document.getElementById('batchFileDownload');
if (singleFileDiv) singleFileDiv.classList.remove('hidden');
if (batchFileDiv) batchFileDiv.classList.add('hidden');

downloadArea.classList.remove('hidden');
translateBtn.disabled = false;
translateBtn.classList.remove('hidden');
cancelBtn.classList.add('hidden');
isTranslating = false;
stopTimeUpdate(); // 停止实时时长更新

} catch (error) {
stopTimeUpdate(); // 停止实时时长更新
addLog('翻译过程中出错: ' + error.message, true);
translateBtn.disabled = false;
translateBtn.classList.remove('hidden');
cancelBtn.classList.add('hidden');
isTranslating = false;
}
}

// 清空所有数据
function resetAllData() {
// 清空日志
progressLog.innerHTML = '';

// 重置进度
updateProgress('', 0);

// 重置Token统计
resetTokenCount();

// 重置字数统计
totalCharsToTranslate = 0;
translatedChars = 0;

// 清空对比窗口
if (originalTextDiv) originalTextDiv.textContent = '';
if (translatedTextDiv) translatedTextDiv.textContent = '';

// 隐藏下载区域
downloadArea.classList.add('hidden');

// 隐藏进度区域
progressArea.classList.add('hidden');

// 重置翻译按钮
translateBtn.classList.remove('hidden');
cancelBtn.classList.add('hidden');

// 重置竖排转换选项
const convertCheckbox = document.getElementById('convertToHorizontal');
if (convertCheckbox) {
convertCheckbox.checked = false;
}

// 重置状态
isTranslating = false;
shouldCancel = false;
translatedEpub = null;
}

function handleRemoveFile() {
epubFile = null;
epubZip = null;
fileInput.value = '';
fileInfo.classList.add('hidden');
translateBtn.disabled = true;
downloadArea.classList.add('hidden');
progressArea.classList.add('hidden');

// 重置竖排检测状态
isVerticalMode = false;
const verticalConvertOption = document.getElementById('verticalConvertOption');
if (verticalConvertOption) {
verticalConvertOption.classList.add('hidden');
}

// 重置文件详情
document.getElementById('wordCount').textContent = '-';
document.getElementById('detectedLang').textContent = '-';
document.getElementById('textFileCount').textContent = '-';
}

// 分析EPUB内容
async function analyzeEpubContent() {
try {
let totalCharCount = 0; // 总字符数
let totalWordCount = 0; // 总单词数（英文）
let textFileCount = 0;
let charCount = { zh: 0, ja: 0, en: 0, other: 0 };

const files = Object.keys(epubZip.files);

for (const filename of files) {
if (filename.endsWith('.html') || filename.endsWith('.xhtml')) {
textFileCount++;
const file = epubZip.files[filename];
if (!file.dir) {
const content = await file.async('string');

// 统计字数
const parser = new DOMParser();
const doc = parser.parseFromString(content, 'text/html');
const text = doc.body.textContent || '';

// 统计中文字符（包括标点）
const zhChars = (text.match(/[\u4e00-\u9fa5\u3000-\u303f]/g) || []).length;
// 统计日文字符（平假名、片假名）
const jaChars = (text.match(/[\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
// 统计英文字母
const enChars = (text.match(/[a-zA-Z]/g) || []).length;

charCount.zh += zhChars;
charCount.ja += jaChars;
charCount.en += enChars;

// 总字符数（排除空白字符）
const cleanText = text.replace(/\s+/g, '');
totalCharCount += cleanText.length;

// 英文单词数统计
const enWords = (text.match(/[a-zA-Z]+/g) || []).length;
totalWordCount += enWords;
}
}
}

// 更新UI - 根据主要语言显示合适的单位
let displayCount;
let displayUnit;

// 判断主要语言
const maxLang = Object.keys(charCount).reduce((a, b) => charCount[a] > charCount[b] ? a : b);

if (maxLang === 'en' && charCount.en > charCount.zh && charCount.en > charCount.ja) {
// 英文为主，显示单词数
displayCount = totalWordCount;
displayUnit = '单词';
} else {
// 中文/日文为主，显示字符数
displayCount = totalCharCount;
displayUnit = '字';
}

document.getElementById('wordCount').textContent = `${displayCount.toLocaleString()} ${displayUnit}`;
document.getElementById('textFileCount').textContent = textFileCount;

// 检测主要语言
let detectedLang = '未知';
let maxCount = 0;
const langMap = { zh: '中文', ja: '日语', en: '英语', other: '其他' };

for (const [lang, count] of Object.entries(charCount)) {
if (count > maxCount) {
maxCount = count;
detectedLang = langMap[lang];
}
}

document.getElementById('detectedLang').textContent = detectedLang;

// 自动选择源语言并保存检测结果
if (charCount.ja > charCount.zh && charCount.ja > charCount.en) {
detectedSourceLangCode = 'ja';
document.querySelector('input[name="sourceLang"][value="ja"]').checked = true;
addLog(`自动检测源语言: 日语 (${charCount.ja.toLocaleString()} 个日文字符)`);
} else if (charCount.zh > charCount.ja && charCount.zh > charCount.en) {
detectedSourceLangCode = 'zh';
document.querySelector('input[name="sourceLang"][value="zh"]').checked = true;
addLog(`自动检测源语言: 中文 (${charCount.zh.toLocaleString()} 个中文字符)`);
// 中文竖排EPUB也会被检测到，竖排转换选项会在 detectVerticalMode() 中显示
} else if (charCount.en > charCount.ja && charCount.en > charCount.zh) {
detectedSourceLangCode = 'en';
document.querySelector('input[name="sourceLang"][value="en"]').checked = true;
addLog(`自动检测源语言: 英语 (${charCount.en.toLocaleString()} 个英文字符)`);
} else {
detectedSourceLangCode = null; // 无法确定
}

addLog(`文件分析: ${displayCount.toLocaleString()} ${displayUnit}, ${textFileCount} 个HTML文件, 主要语言: ${detectedLang}`);

// 检测竖排模式并自动勾选转换选项
await detectAndEnableVerticalConversion();

} catch (error) {
console.error('分析文件内容时出错:', error);
}
}

// 检测竖排模式并自动启用转换（独立函数）
async function detectAndEnableVerticalConversion() {
try {
let hasVerticalMode = false;
let verticalFeatureCount = 0;

const files = Object.keys(epubZip.files);

// 1. 检查CSS文件中的竖排属性
for (const filename of files) {
if (filename.endsWith('.css')) {
const file = epubZip.files[filename];
if (!file.dir) {
const content = await file.async('string');
const cssContent = content;

// 检查各种竖排CSS属性
const verticalPatterns = [
/writing-mode\s*:\s*vertical/i,
/-epub-writing-mode\s*:\s*vertical/i,
/text-orientation\s*:\s*upright/i,
/text-combine-upright\s*:\s*all/i
];

for (const pattern of verticalPatterns) {
if (pattern.test(cssContent)) {
const matches = (cssContent.match(pattern) || []).length;
verticalFeatureCount += matches;
hasVerticalMode = true;
break;
}
}
}
}
}


// 2. 检查OPF文件中的竖排方向属性
for (const filename of files) {
if (filename.endsWith('.opf')) {
const file = epubZip.files[filename];
if (!file.dir) {
const content = await file.async('string');
const opfContent = content;

// 检查页面方向属性
const opfPatterns = [
/page-progression-direction\s*=\s*"rtl"/i,
/page-progression-direction\s*=\s*'rtl'/i,
/rendition:orientation\s*=\s*"vertical"/i,
/rendition:orientation\s*=\s*'vertical'/i
];

for (const pattern of opfPatterns) {
if (pattern.test(opfContent)) {
const matches = (opfContent.match(pattern) || []).length;
verticalFeatureCount += matches;
hasVerticalMode = true;
break;
}
}
}
}
}


// 3. 检查HTML文件中是否有内联竖排样式
for (const filename of files) {
if (filename.endsWith('.html') || filename.endsWith('.xhtml')) {
const file = epubZip.files[filename];
if (!file.dir) {
const content = await file.async('string');

// 检查内联样式中的竖排属性
const inlinePatterns = [
/style=["'][^"']*writing-mode\s*:\s*vertical/i,
/style=["'][^"']*text-orientation\s*:\s*upright/i
];

for (const pattern of inlinePatterns) {
if (pattern.test(content)) {
verticalFeatureCount++;
hasVerticalMode = true;
break;
}
}
}
}
}


// 如果检测到竖排模式，自动勾选转换选项
if (hasVerticalMode) {
const convertCheckbox = document.getElementById('convertToHorizontal');
if (convertCheckbox && !convertCheckbox.checked) {
convertCheckbox.checked = true;
addLog(`✓ 检测到竖排模式（${verticalFeatureCount} 处竖排特征），已自动启用竖排转横排`);
}

// 如果检测到中文竖排，提示用户是否只做格式转换
const sourceLang = document.querySelector('input[name="sourceLang"]:checked').value;
const targetLang = document.querySelector('input[name="targetLang"]:checked').value;

if (sourceLang === 'zh' && targetLang !== 'zh') {
	// 中文竖排EPUB，询问用户是否只需要格式转换
	const userChoice = confirm(
`📖 检测到中文竖排EPUB

已检测到 ${verticalFeatureCount} 处竖排特征。

您可以选择：
1. 只转换格式（竖排→横排），不翻译内容 - 推荐
2. 翻译成其他语言

点击"确定"：只转换格式（竖排→横排）
点击"取消"：继续翻译流程`
	);

	if (userChoice) {
		// 用户选择只转换格式
		const targetLangCheckbox = document.querySelector('input[name="targetLang"][value="zh"]');
		if (targetLangCheckbox) {
			targetLangCheckbox.checked = true;
			addLog('✓ 已切换到格式转换模式（中文→中文，仅转换竖排为横排）');
		}
	} else {
		addLog('ℹ️ 继续翻译流程');
	}
}
} else {
addLog(`未检测到竖排模式`);
}

} catch (error) {
console.error('检测竖排模式时出错:', error);
}
}


function formatFileSize(bytes) {
if (bytes === 0) return '0 Bytes';
const k = 1024;
const sizes = ['Bytes', 'KB', 'MB', 'GB'];
const i = Math.floor(Math.log(bytes) / Math.log(k));
return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

async function parseEpub(file) {
try {
const arrayBuffer = await file.arrayBuffer();
epubZip = await JSZip.loadAsync(arrayBuffer);
addLog('成功解析 EPUB 文件');

// 检测是否为竖排EPUB
await detectVerticalMode();

} catch (error) {
addLog('解析 EPUB 文件失败: ' + error.message, true);
}
}

// 检测EPUB是否包含竖排格式
async function detectVerticalMode() {
isVerticalMode = false;
const verticalConvertOption = document.getElementById('verticalConvertOption');

try {
// 检查所有HTML和CSS文件
const files = Object.keys(epubZip.files);
let hasVerticalCSS = false;
let verticalDetails = {
writingMode: 0,
direction: 0,
pageProgression: 0,
epubWritingMode: 0,
pageSpread: 0,
renditionOrientation: 0,
renditionSpread: 0
};

addLog('正在检测EPUB格式...');

for (const filename of files) {
if (filename.endsWith('.html') || filename.endsWith('.xhtml') ||
filename.endsWith('.css') || filename.endsWith('.ncx') || filename.endsWith('.opf')) {

const file = epubZip.files[filename];
if (!file.dir) {
const content = await file.async('string');

// 详细检测各种属性（包括多种引号格式）
const wm = (content.match(/writing-mode\s*:\s*vertical/gi) || []).length;
const dir = (content.match(/direction\s*:\s*rtl/gi) || []).length;
const pp = (content.match(/page-progression-direction\s*:\s*rtl/gi) || []).length;
const ewm = (content.match(/-epub-writing-mode\s*:\s*vertical/gi) || []).length;
const pageDir = (content.match(/page-spread-direction\s*:\s*rtl/gi) || []).length;
const spineProp = (content.match(/page-progression-direction\s*=\s*"rtl"/gi) || []).length;
const spinePropSingle = (content.match(/page-progression-direction\s*=\s*'rtl'/gi) || []).length;
const renditionOri = (content.match(/rendition:orientation\s*=\s*"vertical"/gi) || []).length;
const renditionOriSingle = (content.match(/rendition:orientation\s*=\s*'vertical'/gi) || []).length;
const renditionSp = (content.match(/rendition:spread\s*=\s*"(right|left)"/gi) || []).length;

if (wm > 0 || dir > 0 || pp > 0 || ewm > 0 || pageDir > 0 ||
spineProp > 0 || spinePropSingle > 0 || renditionOri > 0 ||
renditionOriSingle > 0 || renditionSp > 0) {
hasVerticalCSS = true;
addLog(`📄 ${filename}:`);
if (wm > 0) addLog(`   - writing-mode: vertical (${wm}个)`);
if (dir > 0) addLog(`   - direction: rtl (${dir}个)`);
if (pp > 0) addLog(`   - page-progression-direction: rtl (${pp}个)`);
if (pageDir > 0) addLog(`   - page-spread-direction: rtl (${pageDir}个)`);
if (spineProp > 0) addLog(`   - page-progression-direction="rtl" (${spineProp}个)`);
if (spinePropSingle > 0) addLog(`   - page-progression-direction='rtl' (${spinePropSingle}个)`);
if (renditionOri > 0) addLog(`   - rendition:orientation="vertical" (${renditionOri}个)`);
if (renditionOriSingle > 0) addLog(`   - rendition:orientation='vertical' (${renditionOriSingle}个)`);
if (renditionSp > 0) addLog(`   - rendition:spread (right/left) (${renditionSp}个)`);
if (ewm > 0) addLog(`   - -epub-writing-mode: vertical (${ewm}个)`);

verticalDetails.writingMode += wm;
verticalDetails.direction += dir;
verticalDetails.pageProgression += pp;
verticalDetails.epubWritingMode += ewm;
verticalDetails.pageSpread += pageDir;
verticalDetails.renditionOrientation += renditionOri + renditionOriSingle;
verticalDetails.renditionSpread += renditionSp;
}
}
}
}

addLog(`检测汇总: writing-mode(${verticalDetails.writingMode}), direction(${verticalDetails.direction}), ` +
`page-progression(${verticalDetails.pageProgression}), page-spread(${verticalDetails.pageSpread}), ` +
`rendition:orientation(${verticalDetails.renditionOrientation}), rendition:spread(${verticalDetails.renditionSpread})`);

if (hasVerticalCSS) {
isVerticalMode = true;
verticalConvertOption.classList.remove('hidden');
addLog('⚠️ 检测到竖排EPUB，可以在下方选择是否转换为横排');
} else {
isVerticalMode = false;
verticalConvertOption.classList.add('hidden');
}

} catch (error) {
console.error('检测竖排格式时出错:', error);
}
}

function handleServiceChange() {
const zhipuApiSettings = document.getElementById('zhipuApiSettings');
const openrouterApiSettings = document.getElementById('openrouterApiSettings');

// Hide all settings first
customApiSettings.classList.add('hidden');
if (zhipuApiSettings) {
zhipuApiSettings.classList.add('hidden');
}
if (openrouterApiSettings) {
openrouterApiSettings.classList.add('hidden');
}

// Show relevant settings based on selection
if (translationService.value === 'custom') {
customApiSettings.classList.remove('hidden');
} else if (translationService.value === 'zhipu') {
zhipuApiSettings.classList.remove('hidden');
} else if (translationService.value === 'openrouter') {
openrouterApiSettings.classList.remove('hidden');
}
}

// 估算token数量
function estimateTokens(text) {
// 粗略估算：中文约1.5字符/token，英文约4字符/token
const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
const englishChars = text.length - chineseChars;
return Math.ceil(chineseChars / 1.5 + englishChars / 4);
}

// 格式化时长显示
function formatDuration(seconds) {
if (seconds < 60) {
// 小于1分钟，只显示秒
return `${Math.round(seconds)} 秒`;
} else {
// 大于等于1分钟，显示分钟和秒
const minutes = Math.floor(seconds / 60);
const remainingSeconds = Math.round(seconds % 60);
return `${minutes}分${remainingSeconds}秒`;
}
}

// 更新token显示（带节流优化）
let lastTokenUpdateTime = 0;
const TOKEN_UPDATE_THROTTLE = 200; // 200ms节流

function updateTokenDisplay() {
const now = Date.now();
if (now - lastTokenUpdateTime < TOKEN_UPDATE_THROTTLE) {
return; // 跳过过于频繁的更新
}
lastTokenUpdateTime = now;

// 显示实际的token数
document.getElementById('inputTokens').textContent = totalInputTokens.toLocaleString();
document.getElementById('outputTokens').textContent = totalOutputTokens.toLocaleString();
document.getElementById('totalTokens').textContent = (totalInputTokens + totalOutputTokens).toLocaleString();

// 使用token估算费用
const total = totalInputTokens + totalOutputTokens;
// DeepSeek定价: 约$0.14每百万tokens
const estimatedCost = (total / 1000000 * 0.14).toFixed(4);
document.getElementById('estimatedCost').textContent = `$${estimatedCost}`;

// 更新翻译进度（显示已翻译的原文字数）
// 在批量模式下，显示当前文件的进度；在单文件模式下，显示累积进度
if (isBatchMode && totalCharsToTranslate > 0) {
// 批量模式：只显示当前文件的进度
const progressElement = document.getElementById('translationProgress');
if (progressElement) {
const progress = Math.round((translatedChars / totalCharsToTranslate) * 100);
progressElement.textContent =
`${translatedChars.toLocaleString()} / ${totalCharsToTranslate.toLocaleString()} 字 (${progress}%)`;
}
} else if (totalCharsToTranslate > 0) {
// 单文件模式：显示累积进度
document.getElementById('translationProgress').textContent =
`${totalSourceChars.toLocaleString()} / ${totalCharsToTranslate.toLocaleString()} 字`;
}

// 更新翻译时长
if (translationStartTime && isTranslating) {
const elapsed = (Date.now() - translationStartTime) / 1000;
document.getElementById('translationTime').textContent = formatDuration(elapsed);
} else if (translationStartTime && !isTranslating) {
// 翻译结束，显示最终时长
const elapsed = (translationEndTime - translationStartTime) / 1000;
document.getElementById('translationTime').textContent = formatDuration(elapsed);
}
}

// 重置token统计
function resetTokenCount() {
totalInputTokens = 0;
totalOutputTokens = 0;
totalSourceChars = 0;
totalTranslatedChars = 0;
updateTokenDisplay();
}

// 启动实时时长更新
function startTimeUpdate() {
// 清除旧的定时器（如果存在）
if (timeUpdateInterval) {
clearInterval(timeUpdateInterval);
}

// 立即更新一次
updateTokenDisplay();

// 每100毫秒更新一次时长显示
timeUpdateInterval = setInterval(() => {
if (translationStartTime && isTranslating) {
const elapsed = (Date.now() - translationStartTime) / 1000;
const timeElement = document.getElementById('translationTime');
if (timeElement) {
timeElement.textContent = formatDuration(elapsed);
}
}
}, 100);
}

// 停止实时时长更新
function stopTimeUpdate() {
if (timeUpdateInterval) {
clearInterval(timeUpdateInterval);
timeUpdateInterval = null;
}

// 更新最终时长
if (translationStartTime && translationEndTime) {
const elapsed = (translationEndTime - translationStartTime) / 1000;
const timeElement = document.getElementById('translationTime');
if (timeElement) {
timeElement.textContent = formatDuration(elapsed);
}
}
}

// 检测并转换竖排为横排
function convertVerticalToHorizontal(html) {
// 检查用户是否选择了转换为横排
const convertCheckbox = document.getElementById('convertToHorizontal');
const shouldConvert = convertCheckbox ? convertCheckbox.checked : false;

if (!shouldConvert) {
return html; // 用户不希望转换
}

let convertedHtml = html;
let conversionCount = 0;

// 检测并转换所有竖排相关的writing-mode
// 检查vertical-rl（多种可能的格式）
const verticalRlMatches = (html.match(/vertical-rl/gi) || []).length;
if (verticalRlMatches > 0) {
addLog(`  -> 发现 ${verticalRlMatches} 个 vertical-rl`);
}

// 检查vertical-lr
const verticalLrMatches = (html.match(/vertical-lr/gi) || []).length;
if (verticalLrMatches > 0) {
addLog(`  -> 发现 ${verticalLrMatches} 个 vertical-lr`);
}

// 检查-epub-writing-mode
const epubMatches = (html.match(/-epub-writing-mode.*vertical/gi) || []).length;
if (epubMatches > 0) {
addLog(`  -> 发现 ${epubMatches} 个 -epub-writing-mode`);
}

if (verticalRlMatches === 0 && verticalLrMatches === 0 && epubMatches === 0) {
// 没有竖排属性，直接返回
return html;
}

addLog(`开始横排转换...`);

// 1. 转换writing-mode属性
const patterns = [
// 标准格式: writing-mode: vertical-rl;
/writing-mode\s*:\s*vertical-rl\s*;?/gi,
// 无空格: writing-mode:vertical-rl;
/writing-mode:vertical-rl\s*;?/gi,
// 带引号: writing-mode: "vertical-rl";
/writing-mode\s*:\s*['"]vertical-rl['"]\s*;?/gi,
// 同样处理 vertical-lr
/writing-mode\s*:\s*vertical-lr\s*;?/gi,
/writing-mode:vertical-lr\s*;?/gi,
/writing-mode\s*:\s*['"]vertical-lr['"]\s*;?/gi,
];

for (const pattern of patterns) {
convertedHtml = convertedHtml.replace(pattern, () => {
conversionCount++;
return 'writing-mode: horizontal-tb;';
});
}

if (conversionCount > 0) {
addLog(`  -> ✓ 转换为 horizontal-tb: ${conversionCount} 个`);
}

// 2. 移除 -epub-writing-mode 属性
const epubPatterns = [
/-epub-writing-mode\s*:\s*vertical-rl\s*;?/gi,
/-epub-writing-mode\s*:\s*vertical-lr\s*;?/gi,
/-epub-writing-mode:vertical-rl\s*;?/gi,
/-epub-writing-mode:vertical-lr\s*;?/gi,
];

for (const pattern of epubPatterns) {
convertedHtml = convertedHtml.replace(pattern, '');
}

if (epubMatches > 0) {
addLog(`  -> ✓ 移除 -epub-writing-mode: ${epubMatches} 个`);
}

// 3. 转换方向属性：direction: rtl -> direction: ltr
let directionRtlBefore = 0;
convertedHtml = convertedHtml.replace(/direction\s*:\s*rtl\s*;?/gi, () => {
directionRtlBefore++;
return 'direction: ltr;';
});
if (directionRtlBefore > 0) {
addLog(`  -> ✓ 转换方向 rtl->ltr: ${directionRtlBefore} 个`);
}

// 4. 转换文本对齐：text-align: right -> text-align: left
let textAlignRightBefore = 0;
convertedHtml = convertedHtml.replace(/text-align\s*:\s*right\s*;?/gi, () => {
textAlignRightBefore++;
return 'text-align: left;';
});
if (textAlignRightBefore > 0) {
addLog(`  -> ✓ 转换对齐 right->left: ${textAlignRightBefore} 个`);
}

// 5. 移除text-orientation属性（竖排专用）
let orientationBefore = 0;
convertedHtml = convertedHtml.replace(/text-orientation\s*:\s*\w+\s*;?/gi, () => {
orientationBefore++;
return '';
});
if (orientationBefore > 0) {
addLog(`  -> ✓ 移除 text-orientation: ${orientationBefore} 个`);
}

// 6. 移除text-combine-upright（文字组合属性）
let combineBefore = 0;
convertedHtml = convertedHtml.replace(/text-combine-upright\s*:\s*\w+\s*;?/gi, () => {
combineBefore++;
return '';
});
if (combineBefore > 0) {
addLog(`  -> ✓ 移除 text-combine-upright: ${combineBefore} 个`);
}

// 7. 移除layout-grid相关属性（日文竖排常用）
let layoutGridBefore = 0;
convertedHtml = convertedHtml.replace(/layout-grid\s*:[^;]+;?/gi, () => {
layoutGridBefore++;
return '';
});
if (layoutGridBefore > 0) {
addLog(`  -> ✓ 移除 layout-grid: ${layoutGridBefore} 个`);
}

// 8. 处理可能的page-progression-direction属性（CSS格式）
let pageProgressionBefore = 0;
convertedHtml = convertedHtml.replace(/page-progression-direction\s*:\s*rtl\s*;?/gi, () => {
pageProgressionBefore++;
return 'page-progression-direction: ltr;';
});
if (pageProgressionBefore > 0) {
addLog(`  -> ✓ 转换CSS页面方向 rtl->ltr: ${pageProgressionBefore} 个`);
}

// 9. 处理page-spread-direction属性
let pageSpreadBefore = 0;
convertedHtml = convertedHtml.replace(/page-spread-direction\s*:\s*rtl\s*;?/gi, () => {
pageSpreadBefore++;
return 'page-spread-direction: ltr;';
});
if (pageSpreadBefore > 0) {
addLog(`  -> ✓ 转换页面展开方向 rtl->ltr: ${pageSpreadBefore} 个`);
}

// 10. 处理属性格式的page-progression-direction（XML属性，合并多种引号格式）
let pageProgressionAttrTotal = 0;
convertedHtml = convertedHtml.replace(/page-progression-direction\s*=\s*(['"]?)rtl\1(?!\w)/gi, (_, quote) => {
pageProgressionAttrTotal++;
return `page-progression-direction=${quote}ltr${quote}`;
});
if (pageProgressionAttrTotal > 0) {
addLog(`  -> ✓ 转换XML页面方向属性 rtl->ltr: ${pageProgressionAttrTotal} 个`);
}

// 11. 处理属性格式的page-spread-direction（合并多种引号格式，单次扫描）
let pageSpreadAttrTotal = 0;
convertedHtml = convertedHtml.replace(/page-spread-direction\s*=\s*(['"]?)rtl\1(?!\w)/gi, (_, quote) => {
pageSpreadAttrTotal++;
return `page-spread-direction=${quote}ltr${quote}`;
});
if (pageSpreadAttrTotal > 0) {
addLog(`  -> ✓ 转换XML页面展开属性 rtl->ltr: ${pageSpreadAttrTotal} 个`);
}

// 12. 处理可能的rendition:orientation属性（合并多种引号格式，单次扫描）
let orientationAttrTotal = 0;
convertedHtml = convertedHtml.replace(/rendition:orientation\s*=\s*(['"]?)vertical\1/gi, (_, quote) => {
orientationAttrTotal++;
return `rendition:orientation=${quote}auto${quote}`;
});
if (orientationAttrTotal > 0) {
addLog(`  -> ✓ 移除竖排方向属性: ${orientationAttrTotal} 个`);
}

// 13. 处理rendition:spread属性（控制页面展开方式）
// 13. 处理rendition:spread属性（合并 right/left 为单次扫描）
let renditionSpreadTotal = 0;
convertedHtml = convertedHtml.replace(/rendition:spread\s*=\s*"(?:right|left)"/gi, () => {
renditionSpreadTotal++;
return 'rendition:spread="auto"';
});
if (renditionSpreadTotal > 0) {
addLog(`  -> ✓ 转换spread属性 right/left->auto: ${renditionSpreadTotal} 个`);
}

if (conversionCount > 0 || epubMatches > 0 || directionRtlBefore > 0) {
addLog(`✓ 竖排转横排完成`);
}

return convertedHtml;
}

async function handleTranslate() {
const sourceLang = document.querySelector('input[name="sourceLang"]:checked').value;
const targetLang = document.querySelector('input[name="targetLang"]:checked').value;
const service = translationService.value;

// 特殊处理：中文转中文（只做格式转换，不翻译）
if (sourceLang === 'zh' && targetLang === 'zh') {
addLog('📌 检测到中文转中文模式，将跳过翻译，仅处理格式转换（如竖排转横排）');

// 检查是否启用了竖排转换
const convertCheckbox = document.getElementById('convertToHorizontal');
const shouldConvert = convertCheckbox && convertCheckbox.checked;

if (!shouldConvert) {
// 如果既不翻译也不转换格式，提示用户
const confirmOnly = confirm('检测到源语言和目标语言都是中文，且未启用竖排转换。\n\n是否继续生成EPUB（不做任何修改）？');
if (!confirmOnly) {
return;
}
}

// 执行格式转换处理（不需要翻译）
await handleChineseToChineseConversion();
return;
}

// 验证源语言和目标语言不同（其他语言组合）
if (sourceLang === targetLang) {
alert('源语言和目标语言不能相同，请重新选择');
return;
}

// 检查用户选择的源语言和检测到的语言是否一致
if (detectedSourceLangCode && detectedSourceLangCode !== sourceLang) {
const detectedLangName = LANG_NAMES[detectedSourceLangCode] || detectedSourceLangCode;
const selectedLangName = LANG_NAMES[sourceLang] || sourceLang;

const warningMessage =
`⚠️ 语言检测警告\n\n` +
`文件内容检测为：${detectedLangName}\n` +
`您选择的源语言为：${selectedLangName}\n\n` +
`两者不一致，可能会影响翻译质量。\n\n` +
`是否继续翻译？`;

const shouldContinue = confirm(warningMessage);
if (!shouldContinue) {
addLog('⚠️ 用户取消了翻译（语言不匹配）');
return;
}

addLog(`⚠️ 注意：检测到的语言(${detectedLangName})与选择的源语言(${selectedLangName})不一致，将继续翻译`);
}

// 检查是否有文件列表需要处理
if (fileListData.length > 1) {
// 多个文件：使用批量处理
const files = fileListData.map(fileInfo => fileInfo.fileObject).filter(f => f);
addLog(`检测到 ${fileListData.length} 个文件，提取到 ${files.length} 个有效文件对象`);
if (files.length > 0) {
// 设置UI状态（在调用批量处理之前）
progressArea.classList.remove('hidden');
downloadArea.classList.add('hidden');
progressLog.innerHTML = '';
translateBtn.disabled = true;
translateBtn.classList.add('hidden');
cancelBtn.classList.remove('hidden');
cancelBtn.disabled = false;
isTranslating = true;
shouldCancel = false;

// 重置token统计和进度统计
resetTokenCount();
totalCharsToTranslate = 0;
translatedChars = 0;
translationStartTime = Date.now();
translationEndTime = null;
startTimeUpdate(); // 启动实时时长更新

const modeNames = { quick: '快速', standard: '标准', refined: '精翻' };
addLog(`📋 翻译质量模式：${modeNames[getTranslationMode()] || '标准'}`);
const glossary = parseGlossary();
if (glossary) addLog(`📖 已加载 ${glossary.length} 条自定义术语`);
addLog(`准备批量翻译 ${files.length} 个文件...`);
// 调用批量处理，传递语言参数和服务类型
await processMultipleFiles(files, sourceLang, targetLang, service);
return;
} else {
addLog('⚠️ 错误：文件列表中有文件，但无法提取文件对象', true);
}
} else if (fileListData.length === 1) {
// 单个文件：使用单文件翻译流程，但使用 fileListData 中的文件
const singleFile = fileListData[0].fileObject;
if (singleFile && !epubZip) {
// 如果还没有解析过，先解析
await parseEpub(singleFile);
await analyzeEpubContent();
}
// 继续执行下面的单文件翻译流程
} else if (fileListData.length === 0) {
// 没有文件
alert('请先上传EPUB文件');
return;
}

// Reset UI and state
progressArea.classList.remove('hidden');
downloadArea.classList.add('hidden');
progressLog.innerHTML = '';
translateBtn.disabled = true;
translateBtn.classList.add('hidden');
cancelBtn.classList.remove('hidden');
cancelBtn.disabled = false;
cancelBtn.innerHTML = '<span class="flex items-center justify-center"><svg class="h-5 w-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>取消翻译</span>';
isTranslating = true;
shouldCancel = false;

// 重置token统计和进度统计
resetTokenCount();
totalCharsToTranslate = 0;
translatedChars = 0;
translationStartTime = Date.now();
translationEndTime = null;
startTimeUpdate(); // 启动实时时长更新

// 清空对比窗口
if (originalTextDiv) originalTextDiv.textContent = '准备中...';
if (translatedTextDiv) translatedTextDiv.textContent = '准备中...';

// 记录翻译信息
const modeNamesSingle = { quick: '快速', standard: '标准', refined: '精翻' };
addLog(`📋 翻译质量模式：${modeNamesSingle[getTranslationMode()] || '标准'}`);
const glossarySingle = parseGlossary();
if (glossarySingle) addLog(`📖 已加载 ${glossarySingle.length} 条自定义术语`);
addLog(`开始翻译: ${sourceLang} -> ${targetLang}`);

try {
// 首先统计总字数
addLog('正在统计文件字数...');
const files = Object.keys(epubZip.files);

for (const filename of files) {
if (filename.endsWith('.html') || filename.endsWith('.xhtml')) {
const file = epubZip.files[filename];
if (!file.dir) {
const content = await file.async('string');
const parser = new DOMParser();
const doc = parser.parseFromString(content, 'text/html');
const text = doc.body.textContent || '';
const words = text.trim().replace(/\s+/g, '');
totalCharsToTranslate += words.length;
}
}
}

addLog(`统计完成: 共 ${totalCharsToTranslate.toLocaleString()} 字待翻译`);

// Create new zip for translated content
translatedEpub = new JSZip();

// Copy all files
let processedFiles = 0;

// 分离HTML文件和非HTML文件
const htmlFiles = [];
const otherFiles = [];
for (const filename of files) {
const file = epubZip.files[filename];
if (!file.dir) {
if (filename.endsWith('.html') || filename.endsWith('.xhtml')) {
htmlFiles.push(filename);
} else {
otherFiles.push(filename);
}
}
}

addLog(`文件分类: ${htmlFiles.length} 个HTML文件（将并发翻译），${otherFiles.length} 个其他文件`);

// 并发翻译HTML文件（一次处理4个文件）
const CONCURRENT_FILES = 8;
for (let i = 0; i < htmlFiles.length; i += CONCURRENT_FILES) {
// 检查是否需要取消
if (shouldCancel) {
stopTimeUpdate(); // 停止实时时长更新
addLog('⚠️ 翻译已取消', true);
isTranslating = false;
translateBtn.disabled = false;
translateBtn.classList.remove('hidden');
cancelBtn.classList.add('hidden');
return;
}

const batchEnd = Math.min(i + CONCURRENT_FILES, htmlFiles.length);
const currentBatch = htmlFiles.slice(i, batchEnd);

addLog(`并发翻译文件组 ${Math.floor(i/CONCURRENT_FILES) + 1}: ${currentBatch.map(f => f.split('/').pop()).join(', ')}`);

// 并发翻译当前批次的文件
const translationPromises = currentBatch.map(async (filename) => {
const file = epubZip.files[filename];
const content = await file.async('arraybuffer');

updateProgress(`正在翻译: ${filename}`, (translatedChars / totalCharsToTranslate) * 100);
addLog(`处理文件: ${filename}`);

const textContent = new TextDecoder().decode(content);
const translatedText = await translateText(textContent, sourceLang, targetLang, service);

// 更新已翻译字数
const parser = new DOMParser();
const doc = parser.parseFromString(textContent, 'text/html');
const text = doc.body.textContent || '';
const charCount = text.trim().replace(/\s+/g, '').length;
translatedChars += charCount;
updateTokenDisplay();

// 验证翻译后的内容
const translatedParser = new DOMParser();
const translatedDoc = translatedParser.parseFromString(translatedText, 'text/html');
const translatedBodyText = translatedDoc.body.textContent || '';
const translatedBodyLength = translatedBodyText.trim().length;
const translatedInnerLength = translatedDoc.body.innerHTML.trim().length;

// 检查内容是否真正为空（包括SVG等非文本元素）
if (translatedBodyLength === 0 && translatedInnerLength === 0) {
addLog(`⚠️ 警告: ${filename} 翻译后内容为空！`, true);
} else if (translatedBodyLength === 0 && translatedInnerLength > 0) {
// 有HTML内容但没有文本（如SVG），这是正常的
addLog(`  -> ✓ 翻译完成（仅包含非文本内容，如SVG/图片）`);
} else {
addLog(`  -> ✓ 翻译完成，内容长度: ${translatedBodyLength} 字`);
}

// 更新进度显示
const progress = Math.round((translatedChars / totalCharsToTranslate) * 100);
updateProgress(`翻译中... ${translatedChars.toLocaleString()}/${totalCharsToTranslate.toLocaleString()} 字 (${progress}%)`, progress);

return { filename, translatedText };
});

// 等待当前批次的所有文件翻译完成
const results = await Promise.all(translationPromises);

// 保存翻译结果
for (const result of results) {
await translatedEpub.file(result.filename, result.translatedText);
}

// 更新进度
addLog(`进度: ${translatedChars.toLocaleString()}/${totalCharsToTranslate.toLocaleString()} 字 (${Math.round((translatedChars / totalCharsToTranslate) * 100)}%)`);
}

// 处理非HTML文件
for (const filename of otherFiles) {
const file = epubZip.files[filename];
const content = await file.async('arraybuffer');

if (filename.endsWith('.opf')) {
// 处理OPF文件（元数据）
addLog(`处理元数据: ${filename}`);

let opfContent = new TextDecoder().decode(content);

// 检查并转换OPF中的页面方向属性
const convertCheckbox = document.getElementById('convertToHorizontal');
if (convertCheckbox && convertCheckbox.checked) {
addLog(`  -> 检查OPF文件中的页面方向...`);

// 转换page-progression-direction属性（多种引号格式）
const opfPageProgressionDouble = (opfContent.match(/page-progression-direction\s*=\s*"rtl"/gi) || []).length;
const opfPageProgressionSingle = (opfContent.match(/page-progression-direction\s*=\s*'rtl'/gi) || []).length;
const opfPageProgressionNoQuote = (opfContent.match(/page-progression-direction\s*=\s*rtl(?!\w)/gi) || []).length;
const totalPageProgression = opfPageProgressionDouble + opfPageProgressionSingle + opfPageProgressionNoQuote;

if (totalPageProgression > 0) {
if (opfPageProgressionDouble > 0) {
opfContent = opfContent.replace(
/page-progression-direction\s*=\s*"rtl"/gi,
'page-progression-direction="ltr"'
);
}
if (opfPageProgressionSingle > 0) {
opfContent = opfContent.replace(
/page-progression-direction\s*=\s*'rtl'/gi,
"page-progression-direction='ltr'"
);
}
if (opfPageProgressionNoQuote > 0) {
opfContent = opfContent.replace(
/page-progression-direction\s*=\s*rtl(?!\w)/gi,
'page-progression-direction=ltr'
);
}
addLog(`  -> ✓ 转换OPF中spine的页面方向: ${totalPageProgression} 个`);
}

// 转换rendition:orientation属性（多种引号格式）
const renditionOriDouble = (opfContent.match(/rendition:orientation\s*=\s*"vertical"/gi) || []).length;
const renditionOriSingle = (opfContent.match(/rendition:orientation\s*=\s*'vertical'/gi) || []).length;
const totalRenditionOri = renditionOriDouble + renditionOriSingle;

if (totalRenditionOri > 0) {
if (renditionOriDouble > 0) {
opfContent = opfContent.replace(
/rendition:orientation\s*=\s*"vertical"/gi,
'rendition:orientation="auto"'
);
}
if (renditionOriSingle > 0) {
opfContent = opfContent.replace(
/rendition:orientation\s*=\s*'vertical'/gi,
"rendition:orientation='auto'"
);
}
addLog(`  -> ✓ 移除OPF中的竖排方向属性: ${totalRenditionOri} 个`);
}

// 转换rendition:spread属性
const renditionSpreadRight = (opfContent.match(/rendition:spread\s*=\s*"right"/gi) || []).length;
const renditionSpreadLeft = (opfContent.match(/rendition:spread\s*=\s*"left"/gi) || []).length;

if (renditionSpreadRight > 0) {
opfContent = opfContent.replace(
/rendition:spread\s*=\s*"right"/gi,
'rendition:spread="auto"'
);
addLog(`  -> ✓ 转换spread属性 right->auto: ${renditionSpreadRight} 个`);
}

if (renditionSpreadLeft > 0) {
opfContent = opfContent.replace(
/rendition:spread\s*=\s*"left"/gi,
'rendition:spread="auto"'
);
addLog(`  -> ✓ 转换spread属性 left->auto: ${renditionSpreadLeft} 个`);
}

// 转换page-spread-direction属性（如果存在）
const pageSpreadDirDouble = (opfContent.match(/page-spread-direction\s*=\s*"rtl"/gi) || []).length;
const pageSpreadDirSingle = (opfContent.match(/page-spread-direction\s*=\s*'rtl'/gi) || []).length;
const totalPageSpread = pageSpreadDirDouble + pageSpreadDirSingle;

if (totalPageSpread > 0) {
if (pageSpreadDirDouble > 0) {
opfContent = opfContent.replace(
/page-spread-direction\s*=\s*"rtl"/gi,
'page-spread-direction="ltr"'
);
}
if (pageSpreadDirSingle > 0) {
opfContent = opfContent.replace(
/page-spread-direction\s*=\s*'rtl'/gi,
"page-spread-direction='ltr'"
);
}
addLog(`  -> ✓ 转换page-spread-direction属性: ${totalPageSpread} 个`);
}
}

// 翻译元数据
const translatedText = await translateMetadata(opfContent, sourceLang, targetLang);
await translatedEpub.file(filename, translatedText);

// 验证翻译后的内容
const translatedParser = new DOMParser();
const translatedDoc = translatedParser.parseFromString(translatedText, 'text/html');
const translatedBodyText = translatedDoc.body.textContent || '';
const translatedBodyLength = translatedBodyText.trim().length;
const translatedInnerLength = translatedDoc.body.innerHTML.trim().length;

// 检查内容是否真正为空（包括SVG等非文本元素）
if (translatedBodyLength === 0 && translatedInnerLength === 0) {
addLog(`⚠️ 警告: ${filename} 翻译后内容为空！`, true);
} else if (translatedBodyLength === 0 && translatedInnerLength > 0) {
// 有HTML内容但没有文本（如SVG），这是正常的
addLog(`  -> ✓ 翻译完成（仅包含非文本内容，如SVG/图片）`);
} else {
addLog(`  -> ✓ 翻译完成，内容长度: ${translatedBodyLength} 字`);
}
} else if (filename.endsWith('.css')) {
// 处理CSS文件 - 转换竖排为横排
addLog(`处理CSS文件: ${filename}`);
const cssContent = new TextDecoder().decode(content);

// 检查CSS中是否包含竖排属性
const hasVerticalMode = /writing-mode\s*:\s*vertical/i.test(cssContent) ||
/-epub-writing-mode\s*:\s*vertical/i.test(cssContent);
if (hasVerticalMode) {
addLog(`  -> CSS文件包含竖排属性`);
}

const convertedCss = convertVerticalToHorizontal(cssContent);
await translatedEpub.file(filename, convertedCss);
} else if (filename.endsWith('.ncx')) {
// NCX文件也可能包含样式，尝试转换
addLog(`处理NCX文件: ${filename}`);
const ncxContent = new TextDecoder().decode(content);
const convertedNcx = convertVerticalToHorizontal(ncxContent);
await translatedEpub.file(filename, convertedNcx);
} else {
// Copy other files as-is
await translatedEpub.file(filename, content);
}
processedFiles++;
}

updateProgress('完成', 100);
addLog('✓ 翻译完成！');

// 更新文件列表状态（单文件模式）
if (fileListData.length > 0) {
	updateFileStatus(0, 'completed');
}

// Show download button
downloadArea.classList.remove('hidden');
translateBtn.disabled = false;
translateBtn.classList.remove('hidden');
cancelBtn.classList.add('hidden');
isTranslating = false;
stopTimeUpdate(); // 停止实时时长更新

} catch (error) {
stopTimeUpdate(); // 停止实时时长更新
addLog('翻译过程中出错: ' + error.message, true);
translateBtn.disabled = false;
translateBtn.classList.remove('hidden');
cancelBtn.classList.add('hidden');
isTranslating = false;
}
}

async function translateText(text, sourceLang, targetLang, service) {
if (service === 'demo') {
// Demo mode: simple text replacement
return demoTranslate(text, sourceLang, targetLang);
} else if (service === 'zhipu') {
// Zhipu AI API
return await translateWithZhipuAI(text, sourceLang, targetLang);
} else if (service === 'openrouter') {
// OpenRouter API
return await translateWithOpenRouter(text, sourceLang, targetLang);
} else {
// Custom API
return await translateWithCustomAPI(text, sourceLang, targetLang);
}
}

function demoTranslate(text, sourceLang, targetLang) {
// Demo mode: just add a prefix to show it's been processed
// In real implementation, you would call a translation API here

// Extract DOCTYPE and original structure
const docTypeMatch = text.match(/<!DOCTYPE[^>]*>/i);
const docType = docTypeMatch ? docTypeMatch[0] : '';

// Extract text content from HTML
const parser = new DOMParser();
const doc = parser.parseFromString(text, 'text/html');

// Simple demo: translate text nodes
const textNodes = [];
const walker = document.createTreeWalker(
doc.body,
NodeFilter.SHOW_TEXT,
null,
false
);

let node;
while (node = walker.nextNode()) {
if (node.textContent.trim()) {
textNodes.push(node);
}
}

// Demo translation - show source and target language

textNodes.forEach(node => {
node.textContent = `[${LANG_NAMES[sourceLang]}→${LANG_NAMES[targetLang]}] ` + node.textContent;
});

// Return with proper HTML structure
return `${docType}\n${doc.documentElement.outerHTML}`;
}

// 清理AI翻译结果中的提示词残留
function cleanTranslatedText(rawText) {
let cleaned = rawText;

// 移除常见的AI回复前缀
const prefixesToRemove = [
/^(以下是翻译结果[：:]\s*)/i,
/^(翻译如下[：:]\s*)/i,
/^(根据要求翻译[：:]\s*)/i,
/^(好的，以下是翻译[：:]\s*)/i,
/^(好的[，,]?我来翻译[：:]\s*)/i,
/^(当然[，,]?以下是翻译[：:]\s*)/i,
/^\[翻译\]\s*/i,
/^(Translation[：:]\s*)/i,
/^(Here is the translation[：:]\s*)/i,
/^(（根据用户要求，严格遵循.*?）)\s*/i,
/^(（译文严格遵守所有要求.*?）)\s*/i,
];

for (const prefix of prefixesToRemove) {
cleaned = cleaned.replace(prefix, '');
}

// 移除常见的AI回复后缀
const suffixesToRemove = [
/\s*(请注意：以上是翻译结果)\s*$/i,
/\s*(希望这个翻译对您有帮助)\s*$/i,
/\s*(如有需要可以进一步调整)\s*$/i,
];

for (const suffix of suffixesToRemove) {
cleaned = cleaned.replace(suffix, '');
}

// 移除中间可能出现的解释性文字（如"翻译说明："等）
cleaned = cleaned.replace(/\n\n翻译说明[：:].*$/gi, '');
cleaned = cleaned.replace(/\n\nNote[：:].*$/gi, '');

// 移除版权信息和元数据（改进版：支持多行匹配）
const metadataPatterns = [
// 匹配 "Excerpt From" 开始的整个块（多行）
/Excerpt From\s*[\s\S]*?This material may be protected by copyright[\s\S]*?$/gim,
// 单独匹配各种元数据模式（只匹配整行）
/^Excerpt From.*$/gim,
/^This material may be protected by copyright.*$/gim,
// 只匹配包含语言标记的元数据行（整行）
/^\s*\[.*?[日中韩英法德俄葡西語語语][\s\-→]*.*?\]\s*$/gim,
// 括号内的说明文字（整行）
/^\s*（根据用户要求.*?）\s*$/gim,
/^\s*（译文严格遵守.*?）\s*$/gim,
// 只包含日文人名的行（整行）
/^[あ-んア-ン一-龯\s]+（[^\)]*）?\s*$/gim,
// 只包含中文人名的行（整行）
/^[一-龯\s]+（[^\)]*）?\s*$/gim,
];

for (const pattern of metadataPatterns) {
cleaned = cleaned.replace(pattern, '');
}

// 移除多余的空白行
cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

// 最后检查：如果清理后为空或太短，返回原文
if (cleaned.trim().length < 2) {
return rawText.trim();
}

return cleaned.trim();
}

async function translateWithZhipuAI(text, sourceLang, targetLang) {
const apiKey = document.getElementById('zhipuApiKey').value;
const baseUrl = document.getElementById('zhipuBaseUrl').value || 'https://open.bigmodel.cn/api/paas/v4/';

if (!apiKey) {
throw new Error('请输入智谱AI API Key');
}

// 使用DOMParser解析HTML
const parser = new DOMParser();
const doc = parser.parseFromString(text, 'text/html');

// 提取段落文本，保持原文结构
const paragraphs = [];

// 方法1：使用TreeWalker遍历所有文本节点，确保不遗漏任何内容
const walker = document.createTreeWalker(
doc.body,
NodeFilter.SHOW_TEXT,
{
acceptNode: function(node) {
// 跳过空白节点
if (!node.textContent || node.textContent.trim().length === 0) {
return NodeFilter.FILTER_REJECT;
}
// 跳过script和style标签内的内容
const parentTag = node.parentElement?.tagName?.toLowerCase();
if (parentTag === 'script' || parentTag === 'style') {
return NodeFilter.FILTER_REJECT;
}
return NodeFilter.FILTER_ACCEPT;
}
},
false
);

// 使用Set来跟踪已处理的元素，避免重复
const processedElements = new Set();

let node;
while (node = walker.nextNode()) {
const text = node.textContent.trim();
if (text.length > 0) {
// 查找最近的块级父元素
let element = node.parentElement;
let foundBlockElement = false;

// 向上查找块级元素
while (element && element !== doc.body) {
const tagName = element.tagName.toLowerCase();
if (BLOCK_TAGS.has(tagName)) {
foundBlockElement = true;
break;
}
element = element.parentElement;
}

// 如果找到了块级元素且未被处理过
if (foundBlockElement && !processedElements.has(element)) {
processedElements.add(element);
const rawText = element.textContent;
const trimText = rawText.trim();

// 检查元素是否包含<br>标签（说明是多段落用<br>分隔的结构）
const hasBrTags = element.innerHTML.includes('<br');

if (hasBrTags && trimText.length >= 1) {
// 对于用<br>分隔的内容，按<br>分割成多个段落
// 先克隆元素，然后遍历其子节点，按<br>分割
const subParagraphs = [];
let currentText = '';

// 遍历元素的所有子节点
Array.from(element.childNodes).forEach(childNode => {
if (childNode.nodeType === Node.TEXT_NODE) {
const text = childNode.textContent;
// 检查是否是全角空格开头的日文段落
if (text.startsWith('　') || text.trim().length > 0) {
currentText += text;
}
} else if (childNode.nodeType === Node.ELEMENT_NODE) {
const tagName = childNode.tagName.toLowerCase();
if (tagName === 'br') {
// <br>标签表示段落结束
if (currentText.trim().length > 0) {
subParagraphs.push(currentText.trim());
currentText = '';
}
} else if (tagName === 'a') {
// 链接标签，提取文本
const linkText = childNode.textContent;
if (linkText.trim().length > 0) {
if (currentText.length > 0 && !currentText.endsWith('\n')) {
currentText += ' ';
}
currentText += linkText;
}
}
// 其他标签如<span>等，提取文本
else {
const text = childNode.textContent;
if (text && text.trim().length > 0) {
currentText += text;
}
}
}
});

// 添加最后一段
if (currentText.trim().length > 0) {
subParagraphs.push(currentText.trim());
}

// 将分割后的段落添加到段落列表
subParagraphs.forEach((paraText) => {
if (paraText.length >= 1) {
paragraphs.push({
element: element,
originalText: paraText,
rawText: paraText,
index: paragraphs.length,
skipReason: null
});
}
});

addLog(`  -> 检测到<br>分隔结构，分割为 ${subParagraphs.length} 个段落`);
} else if (trimText.length >= 1) {
// 普通情况，整个元素作为一个段落
paragraphs.push({
element: element,
originalText: trimText,
rawText: rawText,
index: paragraphs.length,
skipReason: null
});
}
} else if (!foundBlockElement) {
// 如果没有找到块级父元素，直接记录文本节点
paragraphs.push({
element: node.parentElement, // 使用父元素
originalText: text,
rawText: text,
index: paragraphs.length,
skipReason: null,
textNode: node, // 保存文本节点引用
isInline: true
});
}
}
}

addLog(`找到 ${paragraphs.length} 个段落`);

// 诊断：显示前10个提取的段落内容
addLog(`=== 前10个提取的段落 ===`);
paragraphs.slice(0, 10).forEach((para, idx) => {
const preview = para.originalText.substring(0, 80);
// 改进语言检测：基于日文字符（平假名、片假名、汉字）
const hasJapanese = /[ぁ-んァ-ン一-龯]/.test(para.originalText);
const hasEnglish = /[a-zA-Z]{3,}/.test(para.originalText); // 至少3个连续字母才算英文
let lang = '未知';
if (hasJapanese) {
lang = '日文';
} else if (hasEnglish) {
lang = '英文';
} else if (/[一-龯]/.test(para.originalText)) {
lang = '中文';
}
addLog(`  [${idx}] ${lang} (${para.originalText.length}字): "${preview}..."`);
});

// 如果没有找到任何段落，直接返回原始内容（避免序列化导致内容丢失）
if (paragraphs.length === 0) {
addLog(`  -> 未找到可翻译内容，直接使用原始内容`);
// 仍然需要处理竖排转换
let result = text;
const convertCheckbox = document.getElementById('convertToHorizontal');
if (convertCheckbox && convertCheckbox.checked) {
result = convertVerticalToHorizontal(text);
}

// 调试：检查返回内容的长度
const resultParser = new DOMParser();
const resultDoc = resultParser.parseFromString(result, 'text/html');
const resultTextLength = resultDoc.body.textContent.trim().length;
const resultHtmlLength = resultDoc.body.innerHTML.trim().length;
addLog(`  -> 返回内容: 文本${resultTextLength}字, HTML${resultHtmlLength}字`);

return result;
}

// 智能合并：每500-800字一组，减少API调用次数，提高翻译吞吐量
const TARGET_MIN_LENGTH = 500;
const TARGET_MAX_LENGTH = 800;
const groupedParagraphs = [];
let currentBatch = [];
let currentLength = 0;

for (let i = 0; i < paragraphs.length; i++) {
const para = paragraphs[i];
const textLength = para.originalText.length;

// 如果单个段落就超过上限，单独处理
if (textLength > TARGET_MAX_LENGTH) {
// 先保存之前累积的
if (currentBatch.length > 0) {
groupedParagraphs.push({
paragraphs: currentBatch,
combinedText: currentBatch.map(p => p.originalText).join('\n\n'),
count: currentBatch.length
});
currentBatch = [];
currentLength = 0;
}
// 长段落单独成组
groupedParagraphs.push({
paragraphs: [para],
combinedText: para.originalText,
count: 1
});
} else {
// 累积小段落
currentBatch.push(para);
currentLength += textLength;

// 如果达到目标长度或批次够多，保存
if (currentLength >= TARGET_MIN_LENGTH || currentBatch.length >= 12) {
groupedParagraphs.push({
paragraphs: currentBatch,
combinedText: currentBatch.map(p => p.originalText).join('\n\n'),
count: currentBatch.length
});
currentBatch = [];
currentLength = 0;
}
}
}

// 保存剩余的
if (currentBatch.length > 0) {
groupedParagraphs.push({
paragraphs: currentBatch,
combinedText: currentBatch.map(p => p.originalText).join('\n\n'),
count: currentBatch.length
});
}

addLog(`智能合并: ${paragraphs.length} 个段落 → ${groupedParagraphs.length} 个翻译组`);

// 调试：显示前5个待翻译组的长度和内容预览
addLog(`前5个翻译组信息:`);
groupedParagraphs.slice(0, 5).forEach((group, idx) => {
const preview = group.combinedText.substring(0, 100);
addLog(`  组${idx}: ${group.paragraphs.length}段, ${group.combinedText.length}字 - "${preview}..."`);
});

// 信号量控制并发（translationSemaphore 限制最大15个并发请求），一次性处理所有组
const CONCURRENT_BATCHES = Infinity; // 实际并发由 translationSemaphore 控制
let translatedCount = 0;
const maxRetries = 3;
const translationStartTime = Date.now();  // 记录翻译开始时间

for (let batchStart = 0; batchStart < groupedParagraphs.length; batchStart += CONCURRENT_BATCHES) {
// 检查是否需要取消
if (shouldCancel) {
addLog('⚠️ 翻译已取消', true);
break;
}

const batchEnd = Math.min(batchStart + CONCURRENT_BATCHES, groupedParagraphs.length);
const batch = groupedParagraphs.slice(batchStart, batchEnd);

// 并发翻译当前批次（信号量控制实际并发数）
const translationPromises = batch.map(async (group) => {
return translationSemaphore(async () => {
const originalText = group.combinedText;

// 跳过纯数字、标点或过短文本
if (originalText.length < 1) {
// 记录跳过原因
group.paragraphs.forEach(p => p.skipReason = '文本为空');
return { success: true, skipped: true };
}
if (/^[\d\s\p{P}\p{S}]+$/u.test(originalText)) {
// 记录跳过原因
group.paragraphs.forEach(p => p.skipReason = '仅包含数字/标点符号');
return { success: true, skipped: true };
}

let retries = 0;
while (retries < maxRetries) {
try {
// 检查缓存 - 使用无标记的原文作为键
const cacheKey = group.paragraphs.map(p => p.originalText).join('\n\n');
const cachedResult = getFromCache(cacheKey, sourceLang, targetLang);
if (cachedResult) {
// 使用缓存的翻译结果
addLog('  -> 使用缓存的翻译结果');
// 清理可能残留的段落标记
const cleanedCached = cachedResult.replace(/\[P\d+\]\s*/g, '').replace(/^\[P\d+\]/g, '');
const translatedLines = cleanedCached.split(/\n\n+/).map(line => line.trim()).filter(line => line);

group.paragraphs.forEach((para, idx) => {
if (idx < translatedLines.length) {
para.translatedText = translatedLines[idx];
} else {
para.translatedText = para.originalText;
}
});

translatedCount += group.paragraphs.length;
return { success: true, translated: true, groupCount: group.count, fromCache: true };
}

// 更新对比窗口
updateComparisonWindow(
originalText.substring(0, 200) + (originalText.length > 200 ? '...' : ''),
'翻译中...'
);

// 构建翻译提示词 - 使用质量模式感知的prompt构建器
const paraCount = group.paragraphs.length;
const translationMode = getTranslationMode();
const systemPrompt = buildBatchSystemPrompt(sourceLang, targetLang, translationMode);
const userPrompt = buildBatchUserPrompt(originalText, paraCount, translationMode);

// 添加超时控制
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 120000); // 120秒超时

// 精翻模式使用稍高温度以获得更自然的表达
const temperature = translationMode === 'refined' ? 0.4 : 0.3;

const response = await fetch(`${baseUrl}chat/completions`, {
method: 'POST',
headers: {
'Content-Type': 'application/json',
'Authorization': `Bearer ${apiKey}`
},
body: JSON.stringify({
model: 'glm-4-flash',
messages: [
{
role: 'system',
content: systemPrompt
},
{
role: 'user',
content: userPrompt
}
],
temperature: temperature,
max_tokens: 8000
}),
signal: controller.signal
});

clearTimeout(timeoutId);

if (!response.ok) {
const errorData = await response.json().catch(() => ({}));

// 专门处理401认证错误
if (response.status === 401) {
throw new Error('智谱AI API Key 无效或已过期，请检查您的API Key设置');
}

throw new Error(`API 调用失败: ${response.status} - ${errorData.error?.message || response.statusText}`);
}

const data = await response.json();
const translatedText = data.choices[0]?.message?.content?.trim();

if (!translatedText) {
throw new Error('API 返回了空响应');
}

// 清理AI回复中的提示词残留
const cleanedText = cleanTranslatedText(translatedText);

// 添加到缓存 - 使用无标记的原文作为键
addToCache(cacheKey, sourceLang, targetLang, cleanedText);

// 按段落边界分割翻译结果
let translatedLines;
const expectedCount = group.paragraphs.length;

// 首先尝试双换行符分割
const doubleNewlineSplit = cleanedText.split(/\n\n+/).map(line => line.trim()).filter(line => line);

// 如果双换行符分割的数量正确，直接使用
if (doubleNewlineSplit.length === expectedCount) {
translatedLines = doubleNewlineSplit;
addLog(`  -> 使用双换行符分割: ${translatedLines.length}个段落`);
} else {
// 尝试单换行符分割
const singleNewlineSplit = cleanedText.split(/\n/).map(line => line.trim()).filter(line => line.length > 0);
if (singleNewlineSplit.length === expectedCount) {
translatedLines = singleNewlineSplit;
addLog(`  -> 使用单换行符分割: ${translatedLines.length}个段落`);
} else {
// 使用最接近期望数量的分割方式
const splitOptions = [
{ lines: doubleNewlineSplit, name: '双换行符' },
{ lines: singleNewlineSplit, name: '单换行符' }
];

let bestMatch = splitOptions[0];
let minDiff = Math.abs(splitOptions[0].lines.length - expectedCount);

for (const option of splitOptions) {
const diff = Math.abs(option.lines.length - expectedCount);
if (diff < minDiff) {
minDiff = diff;
bestMatch = option;
}
}

translatedLines = bestMatch.lines;
addLog(`  -> 翻译结果: 期望${expectedCount}段，AI返回${translatedLines.length}段（使用${bestMatch.name}分割）`);
}
}

// 清理可能残留的段落标记
translatedLines = translatedLines.map(line => line.replace(/\[P\d+\]\s*/g, '').replace(/^\[P\d+\]/, ''));

// 智能分配翻译结果到各个段落
if (translatedLines.length === expectedCount) {
// 完美匹配：直接分配
group.paragraphs.forEach((para, idx) => {
para.translatedText = translatedLines[idx];
});
} else if (translatedLines.length > expectedCount) {
// AI返回的段落太多：智能合并多余段落
addLog(`  -> 段落过多，尝试智能合并...`);
const linesPerPara = Math.ceil(translatedLines.length / expectedCount);
group.paragraphs.forEach((para, idx) => {
const startIdx = idx * linesPerPara;
const endIdx = Math.min(startIdx + linesPerPara, translatedLines.length);
const segment = translatedLines.slice(startIdx, endIdx).join(' ');
para.translatedText = segment;
});
} else {
// AI返回的段落太少：标记未翻译的段落，稍后重试
addLog(`  -> 段落不足，已翻译部分保留，其余标记重试`, true);
group.paragraphs.forEach((para, idx) => {
if (idx < translatedLines.length) {
para.translatedText = translatedLines[idx];
} else {
// 标记为未翻译
para.translatedText = null;
para.skipReason = `AI返回不足（${translatedLines.length}/${expectedCount}）`;
}
});
}

// 更新对比窗口
updateComparisonWindow(
originalText.substring(0, 200) + (originalText.length > 200 ? '...' : ''),
translatedText.substring(0, 200) + (translatedText.length > 200 ? '...' : '')
);

// 优先使用API返回的实际token数
const apiInputTokens = data.usage?.prompt_tokens;
const apiOutputTokens = data.usage?.completion_tokens;

// 如果API返回了token数，使用实际值；否则使用估算值
const inputTokens = apiInputTokens || estimateTokens(translatePrompt);
const outputTokens = apiOutputTokens || estimateTokens(translatedText);

totalInputTokens += inputTokens;
totalOutputTokens += outputTokens;

// 统计原文和译文字数（用于显示）
totalSourceChars += originalText.trim().length;
totalTranslatedChars += translatedText.trim().length;

updateTokenDisplay();

return { success: true, translated: true, groupCount: group.count };

} catch (error) {
retries++;
if (retries >= maxRetries) {
return { success: false, error: error.message };
}
// 指数退避：第1次500ms，第2次1000ms，第3次2000ms
const backoffDelay = Math.min(500 * Math.pow(2, retries - 1), 2000);
await new Promise(resolve => setTimeout(resolve, backoffDelay));
}
}

return { success: false, error: 'Max retries exceeded' };
}); // end translationSemaphore
}); // end batch.map

// 等待当前批次完成
const results = await Promise.all(translationPromises);

// 统计结果
results.forEach((result, index) => {
const groupIndex = batchStart + index + 1;
const group = batch[index];

if (result.success) {
if (!result.skipped) {
translatedCount += result.groupCount || 1;
}
} else {
const errorMsg = result.error || '未知错误';
addLog(`第 ${groupIndex} 组翻译失败: ${errorMsg}`, true);
// 记录失败原因到所有段落
group.paragraphs.forEach(p => p.skipReason = `API翻译失败: ${errorMsg}`);
}
});

// 更新进度
const progress = Math.round((batchEnd / groupedParagraphs.length) * 100);
updateProgress(`翻译中...`, progress);
addLog(`翻译进度: ${translatedCount}/${paragraphs.length} 段完成 (${progress}%) - 已处理 ${batchEnd}/${groupedParagraphs.length} 组`);

// 移除批次间延迟，提升速度
// if (batchEnd < groupedParagraphs.length) {
//     await new Promise(resolve => setTimeout(resolve, 50));
// }
}

addLog(`✓ 翻译完成！共翻译 ${translatedCount} 个段落`);

// 计算翻译时长
translationEndTime = Date.now();
const translationDuration = translationEndTime - translationStartTime;
const durationSeconds = translationDuration / 1000;
addLog(`翻译时长: ${formatDuration(durationSeconds)}`);
updateTokenDisplay();

// 详细统计：检查有多少段落被翻译
const totalParagraphs = paragraphs.length;
const translatedParagraphs = paragraphs.filter(p => p.translatedText && p.translatedText !== p.originalText).length;
const unchangedParagraphs = totalParagraphs - translatedParagraphs;

addLog(`翻译统计: ${translatedParagraphs}/${totalParagraphs} 段已翻译, ${unchangedParagraphs} 段未变化`);

// 显示未翻译的段落（所有）
const unchangedExamples = paragraphs.filter(p => !p.translatedText || p.translatedText === p.originalText);
if (unchangedExamples.length > 0) {
addLog(`⚠️ 未翻译段落 (共${unchangedParagraphs}段):`);
unchangedExamples.forEach((p, idx) => {
const preview = p.originalText.substring(0, 100) + (p.originalText.length > 100 ? '...' : '');
const reason = p.skipReason ? ` - 原因: ${p.skipReason}` : '';
addLog(`  ${idx + 1}. [${p.originalText.length}字] "${preview}"${reason}`);
});
}

// ========== 自动重试未翻译的段落（并行） ==========
const untranslatedParagraphs = paragraphs.filter(p => !p.translatedText || p.translatedText === p.originalText);
if (untranslatedParagraphs.length > 0) {
addLog(``);
addLog(`🔄 开始并行重试 ${untranslatedParagraphs.length} 个未翻译的段落...`);

const retrySemaphore = createSemaphore(10); // 重试并发上限10
let retrySuccessCount = 0;

const retryPromises = untranslatedParagraphs.map((para, idx) => {
return retrySemaphore(async () => {
if (shouldCancel) return;
addLog(`  [${idx + 1}/${untranslatedParagraphs.length}] 重试段落 ${para.index}: "${para.originalText.substring(0, 50)}..."`);

try {
const singleSystemPrompt = buildSingleRetrySystemPrompt(sourceLang, targetLang);
const singleUserPrompt = buildSingleRetryUserPrompt(para.originalText, sourceLang, targetLang);

const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 60000);

const response = await fetch(`${baseUrl}chat/completions`, {
method: 'POST',
headers: {
'Content-Type': 'application/json',
'Authorization': `Bearer ${apiKey}`
},
body: JSON.stringify({
model: 'glm-4-flash',
messages: [
{ role: 'system', content: singleSystemPrompt },
{ role: 'user', content: singleUserPrompt }
],
temperature: 0.3,
max_tokens: 2000
}),
signal: controller.signal
});

clearTimeout(timeoutId);

if (!response.ok) {
const errorData = await response.json().catch(() => ({}));
throw new Error(`API 调用失败: ${response.status} - ${errorData.error?.message || response.statusText}`);
}

const data = await response.json();
const translatedText = data.choices[0]?.message?.content?.trim();

if (translatedText) {
const cleanedText = cleanTranslatedText(translatedText);
para.translatedText = cleanedText;
para.skipReason = null;
retrySuccessCount++;
addLog(`    ✓ 段落 ${para.index} 翻译成功`);
} else {
addLog(`    ⚠️ 段落 ${para.index} 翻译失败：API返回空响应`, true);
}
} catch (error) {
addLog(`    ⚠️ 段落 ${para.index} 翻译失败：${error.message}`, true);
para.translatedText = para.originalText;
}
});
});

await Promise.all(retryPromises);
translatedCount += retrySuccessCount;
addLog(`🔄 重试完成：额外翻译了 ${retrySuccessCount} 个段落`);
}

// 检查是否有原文残留（在翻译后的HTML中搜索原文特征）
addLog(`正在检查原文残留...`);

// 直接在DOM中修改文本，然后序列化
let replacedCount = 0;
let skippedCount = 0;

// 跟踪已处理的元素，避免重复清空同一个元素（修复多段落共享同一元素的问题）
const replacedElements = new Set();
const elementTranslations = new Map();

// 首先收集属于同一元素的所有段落
paragraphs.forEach((para) => {
if (para.translatedText && para.translatedText !== para.originalText && para.element) {
if (!elementTranslations.has(para.element)) {
elementTranslations.set(para.element, []);
}
elementTranslations.get(para.element).push(para);
}
});

// HTML转义函数
function escapeHtml(text) {
const div = doc.createElement('div');
div.textContent = text;
return div.innerHTML;
}

// 然后处理每个元素
paragraphs.forEach((para, idx) => {
if (para.translatedText && para.translatedText !== para.originalText) {
if (para.textNode) {
// 情况1: 有直接的文本节点引用（内联元素或无块级父元素）
para.textNode.textContent = para.translatedText;
replacedCount++;
} else if (para.textNodes && para.textNodes.length > 0) {
// 情况2: 智能分段的情况：有多个文本节点被合并翻译
// 将翻译文本替换到第一个节点，清空其他节点
para.textNodes.forEach((textNode, nodeIdx) => {
if (nodeIdx === 0) {
// 第一个节点放入完整翻译
textNode.textContent = para.translatedText;
} else {
// 清空其余节点
textNode.textContent = '';
}
});
replacedCount++;
} else if (para.element) {
// 情况3: 块级元素 - 检查该元素是否已被处理过
if (replacedElements.has(para.element)) {
// 已处理过，跳过
return;
}

// 标记为已处理
replacedElements.add(para.element);

// 获取属于该元素的所有翻译段落
const translations = elementTranslations.get(para.element) || [];

// 检查原始HTML中是否有<br>标签（说明是多段落用<br>分隔的结构）
const originalHasBr = para.element.innerHTML.includes('<br');

if (originalHasBr && translations.length > 1) {
// 原始结构是用<br>分隔的，重建内容时保持<br>分隔
let newContent = '';
translations.forEach((p, i) => {
if (i > 0) {
newContent += '<br class="calibre2"/>';
}
newContent += escapeHtml(p.translatedText);
});
para.element.innerHTML = newContent;
replacedCount += translations.length;
addLog(`  [重建${translations.length}段] 用<br>分隔重建元素内容`);
} else {
// 简单情况：直接替换整个元素内容
para.element.textContent = translations.length === 1
? para.translatedText
: translations.map(p => p.translatedText).join('\n\n');
replacedCount += translations.length;
}

// 调试：记录前几个段落的替换情况
if (idx < 5) {
addLog(`  [段落${idx}] 替换: ${para.originalText.substring(0, 50)}... → ${para.translatedText.substring(0, 50)}...`);
}
} else {
addLog(`  [段落${idx}] 跳过: 缺少element/textNode/textNodes引用`);
skippedCount++;
}
} else {
if (idx < 10) { // 只记录前10个未翻译的段落
addLog(`  [段落${idx}] 未翻译: ${para.originalText.substring(0, 50)}... (原因: ${para.skipReason || '无翻译文本'})`);
}
skippedCount++;
}
});

addLog(`文本替换: ${replacedCount} 个已翻译, ${skippedCount} 个保持原样`);

// 诊断：检查翻译后的HTML中是否还有英文
addLog(`=== 翻译后检查 ===`);
const postTranslationWalker = document.createTreeWalker(
doc.body,
NodeFilter.SHOW_TEXT,
null,
false
);

let englishTextCount = 0;
let englishSamples = [];
let checkNode;
while (checkNode = postTranslationWalker.nextNode()) {
const text = checkNode.textContent.trim();
if (text.length > 20 && /[a-zA-Z]{3,}/.test(text)) {
// 检查是否包含连续的英文（至少3个字母）
const englishRatio = (text.match(/[a-zA-Z]/g) || []).length / text.length;
if (englishRatio > 0.3) { // 30%以上是英文字母
englishTextCount++;
if (englishSamples.length < 5) {
englishSamples.push(text.substring(0, 100));
}
}
}
}

if (englishTextCount > 0) {
addLog(`⚠️ 警告: 翻译后仍有 ${englishTextCount} 处包含英文的文本:`, true);
englishSamples.forEach((sample, idx) => {
addLog(`  英文${idx + 1}: "${sample}..."`);
});
} else {
addLog(`✓ 翻译检查通过: 未发现明显的英文残留`);
}

// 清理DOM中的元数据文本节点（在序列化之前）
addLog(`正在清理DOM中的元数据...`);
const metadataPatterns = [
/Excerpt From/i,
/This material may be protected by copyright/i,
/\[.*?[日中韩英法德俄葡西語語语][\s\-→]*.*?\]/i,
];

// 使用TreeWalker遍历所有文本节点
const cleanupWalker = document.createTreeWalker(
doc.body,
NodeFilter.SHOW_TEXT,
null,
false
);

let nodesToRemove = [];
let cleanupNode;
while (cleanupNode = cleanupWalker.nextNode()) {
const nodeText = cleanupNode.textContent.trim();
if (nodeText.length > 0) {
// 检查是否包含元数据
const hasMetadata = metadataPatterns.some(pattern => pattern.test(nodeText));
if (hasMetadata) {
addLog(`  -> 删除元数据节点: "${nodeText.substring(0, 50)}..."`);
nodesToRemove.push(cleanupNode);
}
}
}

// 删除包含元数据的节点
nodesToRemove.forEach(node => {
if (node.parentNode) {
node.parentNode.removeChild(node);
}
});

addLog(`✓ 清理完成: 删除了 ${nodesToRemove.length} 个元数据节点`);

// 序列化DOM为HTML，保留原文结构
let translatedHTML;
try {
// 检查是否是XHTML
const isXHTML = text.toLowerCase().includes('xhtml') ||
text.toLowerCase().includes('<!doctype html public') ||
text.includes('xmlns=');

if (isXHTML) {
// XHTML文件：使用XMLSerializer序列化
const serializer = new XMLSerializer();

// 检查原始文件是否有html标签
const hasHtmlTag = text.toLowerCase().includes('<html');

if (hasHtmlTag) {
// 完整的HTML文档：序列化整个document
const serialized = serializer.serializeToString(doc);

// XMLSerializer 已经生成了完整的文档（包括DOCTYPE），直接使用
translatedHTML = serialized;

addLog('使用XMLSerializer序列化完整文档');
} else {
// 只有body内容：序列化body的子节点
const bodyContent = Array.from(doc.body.childNodes).map(node => {
return serializer.serializeToString(node);
}).join('');

translatedHTML = bodyContent;

addLog('使用XMLSerializer序列化body内容');
}
} else {
// 普通HTML：直接使用outerHTML
translatedHTML = doc.documentElement.outerHTML;

// 如果原始HTML有DOCTYPE，添加回去
const docTypeMatch = text.match(/<!DOCTYPE[^>]*>/i);
if (docTypeMatch) {
translatedHTML = docTypeMatch[0] + '\n' + translatedHTML;
}

addLog('使用标准HTML格式');
}
} catch (error) {
// 如果序列化失败，回退到简单方法
addLog(`序列化失败，使用备选方案: ${error.message}`, true);

// 备选方案：直接使用innerHTML
translatedHTML = doc.body.innerHTML;
}

// 检测并转换竖排为横排
translatedHTML = convertVerticalToHorizontal(translatedHTML);

// 返回完整的HTML结构
return translatedHTML;
}

async function translateWithOpenRouter(text, sourceLang, targetLang) {
const apiKey = document.getElementById('openrouterApiKey').value;
const model = document.getElementById('openrouterModel').value || 'deepseek/deepseek-chat';

if (!apiKey) {
throw new Error('请输入OpenRouter API Key');
}

// 使用DOMParser解析HTML
const parser = new DOMParser();
const doc = parser.parseFromString(text, 'text/html');

// 提取段落文本，保持原文结构
const paragraphs = [];

// 方法1：使用TreeWalker遍历所有文本节点，确保不遗漏任何内容
const walker = document.createTreeWalker(
doc.body,
NodeFilter.SHOW_TEXT,
{
acceptNode: function(node) {
// 跳过空白节点
if (!node.textContent || node.textContent.trim().length === 0) {
return NodeFilter.FILTER_REJECT;
}
// 跳过script和style标签内的内容
const parentTag = node.parentElement?.tagName?.toLowerCase();
if (parentTag === 'script' || parentTag === 'style') {
return NodeFilter.FILTER_REJECT;
}
return NodeFilter.FILTER_ACCEPT;
}
},
false
);

// 使用Set来跟踪已处理的元素，避免重复
const processedElements = new Set();

let node;
while (node = walker.nextNode()) {
const text = node.textContent.trim();
if (text.length > 0) {
// 查找最近的块级父元素
let element = node.parentElement;
let foundBlockElement = false;

// 向上查找块级元素
while (element && element !== doc.body) {
const tagName = element.tagName.toLowerCase();
if (BLOCK_TAGS.has(tagName)) {
foundBlockElement = true;
break;
}
element = element.parentElement;
}

// 如果找到了块级元素且未被处理过
if (foundBlockElement && !processedElements.has(element)) {
processedElements.add(element);
const rawText = element.textContent;
const trimText = rawText.trim();

// 检查元素是否包含<br>标签（说明是多段落用<br>分隔的结构）
const hasBrTags = element.innerHTML.includes('<br');

if (hasBrTags && trimText.length >= 1) {
// 对于用<br>分隔的内容，按<br>分割成多个段落
// 先克隆元素，然后遍历其子节点，按<br>分割
const subParagraphs = [];
let currentText = '';

// 遍历元素的所有子节点
Array.from(element.childNodes).forEach(childNode => {
if (childNode.nodeType === Node.TEXT_NODE) {
const text = childNode.textContent;
// 检查是否是全角空格开头的日文段落
if (text.startsWith('　') || text.trim().length > 0) {
currentText += text;
}
} else if (childNode.nodeType === Node.ELEMENT_NODE) {
const tagName = childNode.tagName.toLowerCase();
if (tagName === 'br') {
// <br>标签表示段落结束
if (currentText.trim().length > 0) {
subParagraphs.push(currentText.trim());
currentText = '';
}
} else if (tagName === 'a') {
// 链接标签，提取文本
const linkText = childNode.textContent;
if (linkText.trim().length > 0) {
if (currentText.length > 0 && !currentText.endsWith('\n')) {
currentText += ' ';
}
currentText += linkText;
}
}
// 其他标签如<span>等，提取文本
else {
const text = childNode.textContent;
if (text && text.trim().length > 0) {
currentText += text;
}
}
}
});

// 添加最后一段
if (currentText.trim().length > 0) {
subParagraphs.push(currentText.trim());
}

// 将分割后的段落添加到段落列表
subParagraphs.forEach((paraText) => {
if (paraText.length >= 1) {
paragraphs.push({
element: element,
originalText: paraText,
rawText: paraText,
index: paragraphs.length,
skipReason: null
});
}
});

addLog(`  -> 检测到<br>分隔结构，分割为 ${subParagraphs.length} 个段落`);
} else if (trimText.length >= 1) {
// 普通情况，整个元素作为一个段落
paragraphs.push({
element: element,
originalText: trimText,
rawText: rawText,
index: paragraphs.length,
skipReason: null
});
}
} else if (!foundBlockElement) {
// 如果没有找到块级父元素，直接记录文本节点
paragraphs.push({
element: node.parentElement, // 使用父元素
originalText: text,
rawText: text,
index: paragraphs.length,
skipReason: null,
textNode: node, // 保存文本节点引用
isInline: true
});
}
}
}

addLog(`找到 ${paragraphs.length} 个段落`);

// 诊断：显示前10个提取的段落内容
addLog(`=== 前10个提取的段落 ===`);
paragraphs.slice(0, 10).forEach((para, idx) => {
const preview = para.originalText.substring(0, 80);
// 改进语言检测：基于日文字符（平假名、片假名、汉字）
const hasJapanese = /[ぁ-んァ-ン一-龯]/.test(para.originalText);
const hasEnglish = /[a-zA-Z]{3,}/.test(para.originalText); // 至少3个连续字母才算英文
let lang = '未知';
if (hasJapanese) {
lang = '日文';
} else if (hasEnglish) {
lang = '英文';
} else if (/[一-龯]/.test(para.originalText)) {
lang = '中文';
}
addLog(`  [${idx}] ${lang} (${para.originalText.length}字): "${preview}..."`);
});

// 如果没有找到任何段落，直接返回原始内容（避免序列化导致内容丢失）
if (paragraphs.length === 0) {
addLog(`  -> 未找到可翻译内容，直接使用原始内容`);
// 仍然需要处理竖排转换
let result = text;
const convertCheckbox = document.getElementById('convertToHorizontal');
if (convertCheckbox && convertCheckbox.checked) {
result = convertVerticalToHorizontal(text);
}

// 调试：检查返回内容的长度
const resultParser = new DOMParser();
const resultDoc = resultParser.parseFromString(result, 'text/html');
const resultTextLength = resultDoc.body.textContent.trim().length;
const resultHtmlLength = resultDoc.body.innerHTML.trim().length;
addLog(`  -> 返回内容: 文本${resultTextLength}字, HTML${resultHtmlLength}字`);

return result;
}

// 智能合并：每500-800字一组，减少API调用次数，提高翻译吞吐量
const TARGET_MIN_LENGTH = 500;
const TARGET_MAX_LENGTH = 800;
const groupedParagraphs = [];
let currentBatch = [];
let currentLength = 0;

for (let i = 0; i < paragraphs.length; i++) {
const para = paragraphs[i];
const textLength = para.originalText.length;

// 如果单个段落就超过上限，单独处理
if (textLength > TARGET_MAX_LENGTH) {
// 先保存之前累积的
if (currentBatch.length > 0) {
groupedParagraphs.push({
paragraphs: currentBatch,
combinedText: currentBatch.map(p => p.originalText).join('\n\n'),
count: currentBatch.length
});
currentBatch = [];
currentLength = 0;
}
// 长段落单独成组
groupedParagraphs.push({
paragraphs: [para],
combinedText: para.originalText,
count: 1
});
} else {
// 累积小段落
currentBatch.push(para);
currentLength += textLength;

// 如果达到目标长度或批次够多，保存
if (currentLength >= TARGET_MIN_LENGTH || currentBatch.length >= 12) {
groupedParagraphs.push({
paragraphs: currentBatch,
combinedText: currentBatch.map(p => p.originalText).join('\n\n'),
count: currentBatch.length
});
currentBatch = [];
currentLength = 0;
}
}
}

// 保存剩余的
if (currentBatch.length > 0) {
groupedParagraphs.push({
paragraphs: currentBatch,
combinedText: currentBatch.map(p => p.originalText).join('\n\n'),
count: currentBatch.length
});
}

addLog(`智能合并: ${paragraphs.length} 个段落 → ${groupedParagraphs.length} 个翻译组`);

// 调试：显示前5个待翻译组的长度和内容预览
addLog(`前5个翻译组信息:`);
groupedParagraphs.slice(0, 5).forEach((group, idx) => {
const preview = group.combinedText.substring(0, 100);
addLog(`  组${idx}: ${group.paragraphs.length}段, ${group.combinedText.length}字 - "${preview}..."`);
});

// 信号量控制并发（translationSemaphore 限制最大15个并发请求），一次性处理所有组
const CONCURRENT_BATCHES = Infinity; // 实际并发由 translationSemaphore 控制
let translatedCount = 0;
const maxRetries = 3;
const translationStartTime = Date.now();  // 记录翻译开始时间

for (let batchStart = 0; batchStart < groupedParagraphs.length; batchStart += CONCURRENT_BATCHES) {
// 检查是否需要取消
if (shouldCancel) {
addLog('⚠️ 翻译已取消', true);
break;
}

const batchEnd = Math.min(batchStart + CONCURRENT_BATCHES, groupedParagraphs.length);
const batch = groupedParagraphs.slice(batchStart, batchEnd);

// 并发翻译当前批次（信号量控制实际并发数）
const translationPromises = batch.map(async (group) => {
return translationSemaphore(async () => {
const originalText = group.combinedText;

// 跳过纯数字、标点或过短文本
if (originalText.length < 1) {
// 记录跳过原因
group.paragraphs.forEach(p => p.skipReason = '文本为空');
return { success: true, skipped: true };
}
if (/^[\d\s\p{P}\p{S}]+$/u.test(originalText)) {
// 记录跳过原因
group.paragraphs.forEach(p => p.skipReason = '仅包含数字/标点符号');
return { success: true, skipped: true };
}

let retries = 0;
while (retries < maxRetries) {
try {
// 检查缓存 - 使用无标记的原文作为键
const cacheKey = group.paragraphs.map(p => p.originalText).join('\n\n');
const cachedResult = getFromCache(cacheKey, sourceLang, targetLang);
if (cachedResult) {
// 使用缓存的翻译结果
addLog('  -> 使用缓存的翻译结果');
// 清理可能残留的段落标记
const cleanedCached = cachedResult.replace(/\[P\d+\]\s*/g, '').replace(/^\[P\d+\]/g, '');
const translatedLines = cleanedCached.split(/\n\n+/).map(line => line.trim()).filter(line => line);

group.paragraphs.forEach((para, idx) => {
if (idx < translatedLines.length) {
para.translatedText = translatedLines[idx];
} else {
para.translatedText = para.originalText;
}
});

translatedCount += group.paragraphs.length;
return { success: true, translated: true, groupCount: group.count, fromCache: true };
}

// 更新对比窗口 - 显示原文
updateComparisonWindow(
originalText.substring(0, 200) + (originalText.length > 200 ? '...' : ''),
'翻译中...'
);

// 构建翻译提示词 - 使用质量模式感知的prompt构建器
const paraCount = group.paragraphs.length;
const translationMode = getTranslationMode();
const systemPrompt = buildBatchSystemPrompt(sourceLang, targetLang, translationMode);
const userPrompt = buildBatchUserPrompt(originalText, paraCount, translationMode);

// 添加超时控制
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 120000); // 120秒超时

// 精翻模式使用稍高温度以获得更自然的表达
const temperature = translationMode === 'refined' ? 0.4 : 0.3;

const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
method: 'POST',
headers: {
'Content-Type': 'application/json',
'Authorization': `Bearer ${apiKey}`,
'HTTP-Referer': window.location.href,
'X-Title': 'EPUB Translator'
},
body: JSON.stringify({
model: model,
messages: [
{
role: 'system',
content: systemPrompt
},
{
role: 'user',
content: userPrompt
}
],
temperature: temperature,
max_tokens: 8000
}),
signal: controller.signal
});

clearTimeout(timeoutId);

if (!response.ok) {
// 专门处理401认证错误
if (response.status === 401) {
throw new Error('OpenRouter API Key 无效或已过期，请检查您的API Key设置');
}

const errorText = await response.text();
let errorMsg = `API 调用失败: ${response.status}`;
try {
const errorJson = JSON.parse(errorText);
if (errorJson.error?.message) {
errorMsg += ` - ${errorJson.error.message}`;
}
} catch {
errorMsg += ` - ${errorText}`;
}
throw new Error(errorMsg);
}

const data = await response.json();

if (!data.choices || !data.choices[0] || !data.choices[0].message?.content) {
throw new Error('API 返回数据格式不正确');
}

const translatedText = data.choices[0].message.content.trim();

// 清理AI回复中的提示词残留（如果有）
const cleanedText = cleanTranslatedText(translatedText);

// 添加到缓存
addToCache(originalText, sourceLang, targetLang, cleanedText);

// 按段落边界分割翻译结果
const translatedLines = cleanedText.split(/\n\n+/).map(line => line.trim()).filter(line => line);

// 分配翻译结果到各个段落
group.paragraphs.forEach((para, idx) => {
if (idx < translatedLines.length) {
para.translatedText = translatedLines[idx];
} else {
para.translatedText = para.originalText; // 保持原文
}
});

// 更新对比窗口 - 显示译文
updateComparisonWindow(
originalText.substring(0, 200) + (originalText.length > 200 ? '...' : ''),
translatedText.substring(0, 200) + (translatedText.length > 200 ? '...' : '')
);

// 统计token消耗（用于费用估算）
const inputTokens = estimateTokens(translatePrompt);
const outputTokens = estimateTokens(translatedText);
totalInputTokens += inputTokens;
totalOutputTokens += outputTokens;

// 统计原文和译文字数（用于显示）
totalSourceChars += originalText.trim().length;
totalTranslatedChars += translatedText.trim().length;

updateTokenDisplay();

return { success: true, translated: true, groupCount: group.count };

} catch (error) {
retries++;
if (retries >= maxRetries) {
return { success: false, error: error.message };
}
// 等待后重试
await new Promise(resolve => setTimeout(resolve, 1000 * retries));
}
}

return { success: false, error: 'Max retries exceeded' };
}); // end translationSemaphore
}); // end batch.map

// 等待当前批次完成
const results = await Promise.all(translationPromises);

// 统计结果
results.forEach((result, index) => {
const groupIndex = batchStart + index + 1;
const group = batch[index];

if (result.success) {
if (!result.skipped) {
translatedCount += result.groupCount || 1;
}
} else {
const errorMsg = result.error || '未知错误';
addLog(`第 ${groupIndex} 组翻译失败: ${errorMsg}`, true);
// 记录失败原因到所有段落
group.paragraphs.forEach(p => p.skipReason = `API翻译失败: ${errorMsg}`);
}
});

// 更新进度
const progress = Math.round((batchEnd / groupedParagraphs.length) * 100);
updateProgress(`翻译中...`, progress);
addLog(`翻译进度: ${translatedCount}/${paragraphs.length} 段完成 (${progress}%) - 已处理 ${batchEnd}/${groupedParagraphs.length} 组`);

// 批次延迟已移除：信号量已控制并发，无需额外等待
}

addLog(`✓ 翻译完成！共翻译 ${translatedCount} 个段落`);

// 计算翻译时长
translationEndTime = Date.now();
const translationDuration = translationEndTime - translationStartTime;
const durationSeconds = translationDuration / 1000;
addLog(`翻译时长: ${formatDuration(durationSeconds)}`);
updateTokenDisplay();

// 详细统计：检查有多少段落被翻译
const totalParagraphs = paragraphs.length;
const translatedParagraphs = paragraphs.filter(p => p.translatedText && p.translatedText !== p.originalText).length;
const unchangedParagraphs = totalParagraphs - translatedParagraphs;

addLog(`翻译统计: ${translatedParagraphs}/${totalParagraphs} 段已翻译, ${unchangedParagraphs} 段未变化`);

// 显示未翻译的段落（所有）
const unchangedExamples = paragraphs.filter(p => !p.translatedText || p.translatedText === p.originalText);
if (unchangedExamples.length > 0) {
addLog(`⚠️ 未翻译段落 (共${unchangedParagraphs}段):`);
unchangedExamples.forEach((p, idx) => {
const preview = p.originalText.substring(0, 100) + (p.originalText.length > 100 ? '...' : '');
const reason = p.skipReason ? ` - 原因: ${p.skipReason}` : '';
addLog(`  ${idx + 1}. [${p.originalText.length}字] "${preview}"${reason}`);
});
}

// ========== 自动重试未翻译的段落（并行） ==========
const untranslatedParagraphs = paragraphs.filter(p => !p.translatedText || p.translatedText === p.originalText);
if (untranslatedParagraphs.length > 0) {
addLog(``);
addLog(`🔄 开始并行重试 ${untranslatedParagraphs.length} 个未翻译的段落...`);

const retrySemaphore = createSemaphore(10); // 重试并发上限10
let retrySuccessCount = 0;

const retryPromises = untranslatedParagraphs.map((para, idx) => {
return retrySemaphore(async () => {
if (shouldCancel) return;
addLog(`  [${idx + 1}/${untranslatedParagraphs.length}] 重试段落 ${para.index}: "${para.originalText.substring(0, 50)}..."`);

try {
const singleSystemPrompt = buildSingleRetrySystemPrompt(sourceLang, targetLang);
const singleUserPrompt = buildSingleRetryUserPrompt(para.originalText, sourceLang, targetLang);

const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 60000);

const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
method: 'POST',
headers: {
'Content-Type': 'application/json',
'Authorization': `Bearer ${apiKey}`,
'HTTP-Referer': window.location.href,
'X-Title': 'EPUB Translator'
},
body: JSON.stringify({
model: model,
messages: [
{ role: 'system', content: singleSystemPrompt },
{ role: 'user', content: singleUserPrompt }
],
temperature: 0.3,
max_tokens: 2000
}),
signal: controller.signal
});

clearTimeout(timeoutId);

if (!response.ok) {
if (response.status === 401) {
throw new Error('OpenRouter API Key 无效或已过期，请检查您的API Key设置');
}
const errorData = await response.json().catch(() => ({}));
throw new Error(`API 调用失败: ${response.status} - ${errorData.error?.message || response.statusText}`);
}

const data = await response.json();
const translatedText = data.choices[0]?.message?.content?.trim();

if (translatedText) {
const cleanedText = cleanTranslatedText(translatedText);
para.translatedText = cleanedText;
para.skipReason = null;
retrySuccessCount++;
addLog(`    ✓ 段落 ${para.index} 翻译成功`);
} else {
addLog(`    ⚠️ 段落 ${para.index} 翻译失败：API返回空响应`, true);
}
} catch (error) {
addLog(`    ⚠️ 段落 ${para.index} 翻译失败：${error.message}`, true);
para.translatedText = para.originalText;
}
});
});

await Promise.all(retryPromises);
translatedCount += retrySuccessCount;
addLog(`🔄 重试完成：额外翻译了 ${retrySuccessCount} 个段落`);
}

// 检查是否有原文残留（在翻译后的HTML中搜索原文特征）
addLog(`正在检查原文残留...`);

// 直接在DOM中修改文本，然后序列化
let replacedCount = 0;
let skippedCount = 0;

// 跟踪已处理的元素，避免重复清空同一个元素（修复多段落共享同一元素的问题）
const replacedElements = new Set();
const elementTranslations = new Map();

// 首先收集属于同一元素的所有段落
paragraphs.forEach((para) => {
if (para.translatedText && para.translatedText !== para.originalText && para.element) {
if (!elementTranslations.has(para.element)) {
elementTranslations.set(para.element, []);
}
elementTranslations.get(para.element).push(para);
}
});

// HTML转义函数
function escapeHtml(text) {
const div = doc.createElement('div');
div.textContent = text;
return div.innerHTML;
}

// 然后处理每个元素
paragraphs.forEach((para, idx) => {
if (para.translatedText && para.translatedText !== para.originalText) {
if (para.textNode) {
// 情况1: 有直接的文本节点引用（内联元素或无块级父元素）
para.textNode.textContent = para.translatedText;
replacedCount++;
} else if (para.textNodes && para.textNodes.length > 0) {
// 情况2: 智能分段的情况：有多个文本节点被合并翻译
// 将翻译文本替换到第一个节点，清空其他节点
para.textNodes.forEach((textNode, nodeIdx) => {
if (nodeIdx === 0) {
// 第一个节点放入完整翻译
textNode.textContent = para.translatedText;
} else {
// 清空其余节点
textNode.textContent = '';
}
});
replacedCount++;
} else if (para.element) {
// 情况3: 块级元素 - 检查该元素是否已被处理过
if (replacedElements.has(para.element)) {
// 已处理过，跳过
return;
}

// 标记为已处理
replacedElements.add(para.element);

// 获取属于该元素的所有翻译段落
const translations = elementTranslations.get(para.element) || [];

// 检查原始HTML中是否有<br>标签（说明是多段落用<br>分隔的结构）
const originalHasBr = para.element.innerHTML.includes('<br');

if (originalHasBr && translations.length > 1) {
// 原始结构是用<br>分隔的，重建内容时保持<br>分隔
let newContent = '';
translations.forEach((p, i) => {
if (i > 0) {
newContent += '<br class="calibre2"/>';
}
newContent += escapeHtml(p.translatedText);
});
para.element.innerHTML = newContent;
replacedCount += translations.length;
addLog(`  [重建${translations.length}段] 用<br>分隔重建元素内容`);
} else {
// 简单情况：直接替换整个元素内容
para.element.textContent = translations.length === 1
? para.translatedText
: translations.map(p => p.translatedText).join('\n\n');
replacedCount += translations.length;
}

// 调试：记录前几个段落的替换情况
if (idx < 5) {
addLog(`  [段落${idx}] 替换: ${para.originalText.substring(0, 50)}... → ${para.translatedText.substring(0, 50)}...`);
}
} else {
addLog(`  [段落${idx}] 跳过: 缺少element/textNode/textNodes引用`);
skippedCount++;
}
} else {
if (idx < 10) { // 只记录前10个未翻译的段落
addLog(`  [段落${idx}] 未翻译: ${para.originalText.substring(0, 50)}... (原因: ${para.skipReason || '无翻译文本'})`);
}
skippedCount++;
}
});

addLog(`文本替换: ${replacedCount} 个已翻译, ${skippedCount} 个保持原样`);

// 诊断：检查翻译后的HTML中是否还有英文
addLog(`=== 翻译后检查 ===`);
const postTranslationWalker = document.createTreeWalker(
doc.body,
NodeFilter.SHOW_TEXT,
null,
false
);

let englishTextCount = 0;
let englishSamples = [];
let checkNode;
while (checkNode = postTranslationWalker.nextNode()) {
const text = checkNode.textContent.trim();
if (text.length > 20 && /[a-zA-Z]{3,}/.test(text)) {
// 检查是否包含连续的英文（至少3个字母）
const englishRatio = (text.match(/[a-zA-Z]/g) || []).length / text.length;
if (englishRatio > 0.3) { // 30%以上是英文字母
englishTextCount++;
if (englishSamples.length < 5) {
englishSamples.push(text.substring(0, 100));
}
}
}
}

if (englishTextCount > 0) {
addLog(`⚠️ 警告: 翻译后仍有 ${englishTextCount} 处包含英文的文本:`, true);
englishSamples.forEach((sample, idx) => {
addLog(`  英文${idx + 1}: "${sample}..."`);
});
} else {
addLog(`✓ 翻译检查通过: 未发现明显的英文残留`);
}

// 清理DOM中的元数据文本节点（在序列化之前）
addLog(`正在清理DOM中的元数据...`);
const metadataPatterns = [
/Excerpt From/i,
/This material may be protected by copyright/i,
/\[.*?[日中韩英法德俄葡西語語语][\s\-→]*.*?\]/i,
];

// 使用TreeWalker遍历所有文本节点
const cleanupWalker = document.createTreeWalker(
doc.body,
NodeFilter.SHOW_TEXT,
null,
false
);

let nodesToRemove = [];
let cleanupNode;
while (cleanupNode = cleanupWalker.nextNode()) {
const nodeText = cleanupNode.textContent.trim();
if (nodeText.length > 0) {
// 检查是否包含元数据
const hasMetadata = metadataPatterns.some(pattern => pattern.test(nodeText));
if (hasMetadata) {
addLog(`  -> 删除元数据节点: "${nodeText.substring(0, 50)}..."`);
nodesToRemove.push(cleanupNode);
}
}
}

// 删除包含元数据的节点
nodesToRemove.forEach(node => {
if (node.parentNode) {
node.parentNode.removeChild(node);
}
});

addLog(`✓ 清理完成: 删除了 ${nodesToRemove.length} 个元数据节点`);

// 序列化DOM为HTML，保留原文结构
let translatedHTML;
try {
// 检查是否是XHTML
const isXHTML = text.toLowerCase().includes('xhtml') ||
text.toLowerCase().includes('<!doctype html public') ||
text.includes('xmlns=');

if (isXHTML) {
// XHTML文件：使用XMLSerializer序列化
const serializer = new XMLSerializer();

// 检查原始文件是否有html标签
const hasHtmlTag = text.toLowerCase().includes('<html');

if (hasHtmlTag) {
// 完整的HTML文档：序列化整个document
const serialized = serializer.serializeToString(doc);

// XMLSerializer 已经生成了完整的文档（包括DOCTYPE），直接使用
translatedHTML = serialized;

addLog('使用XMLSerializer序列化完整文档');
} else {
// 只有body内容：序列化body的子节点
const bodyContent = Array.from(doc.body.childNodes).map(node => {
return serializer.serializeToString(node);
}).join('');

translatedHTML = bodyContent;

addLog('使用XMLSerializer序列化body内容');
}
} else {
// 普通HTML：直接使用outerHTML
translatedHTML = doc.documentElement.outerHTML;

// 如果原始HTML有DOCTYPE，添加回去
const docTypeMatch = text.match(/<!DOCTYPE[^>]*>/i);
if (docTypeMatch) {
translatedHTML = docTypeMatch[0] + '\n' + translatedHTML;
}

addLog('使用标准HTML格式');
}
} catch (error) {
// 如果序列化失败，回退到简单方法
addLog(`序列化失败，使用备选方案: ${error.message}`, true);

// 备选方案：直接使用innerHTML
translatedHTML = doc.body.innerHTML;
}

// 检测并转换竖排为横排
translatedHTML = convertVerticalToHorizontal(translatedHTML);

// 返回完整的HTML结构
return translatedHTML;
}

async function translateWithCustomAPI(text, sourceLang, targetLang) {
const endpoint = document.getElementById('apiEndpoint').value;
const apiKey = document.getElementById('apiKey').value;

if (!endpoint || !apiKey) {
throw new Error('请配置 API 端点和密钥');
}

try {
const response = await fetch(endpoint, {
method: 'POST',
headers: {
'Content-Type': 'application/json',
'Authorization': `Bearer ${apiKey}`
},
body: JSON.stringify({
text: text,
source_lang: sourceLang,
target_lang: targetLang
})
});

if (!response.ok) {
throw new Error(`API 请求失败: ${response.status}`);
}

const data = await response.json();
return data.translated_text || text;
} catch (error) {
addLog(`API 调用失败: ${error.message}`, true);
return text; // Return original text on error
}
}

async function translateMetadata(text, sourceLang, targetLang) {
// Simple metadata translation for demo
// Extract DOCTYPE and original structure
const docTypeMatch = text.match(/<!DOCTYPE[^>]*>/i);
const docType = docTypeMatch ? docTypeMatch[0] : '';

const parser = new DOMParser();
const doc = parser.parseFromString(text, 'text/xml');

// Translate title - 不添加前缀，保持原标题不变
// 注释：添加语言标记前缀会导致iBooks解析错误
const titles = doc.getElementsByTagName('dc:title');
// 保持原标题不变，不做任何修改
// for (let title of titles) {
//     if (title.textContent) {
//         title.textContent = `[${LANG_NAMES[sourceLang]}→${LANG_NAMES[targetLang]}] ` + title.textContent;
//     }
// }

// Return with proper XML structure
return `${docType}\n${doc.documentElement.outerHTML}`;
}

function updateProgress(status, percent) {
progressStatus.textContent = status;
progressPercent.textContent = Math.round(percent) + '%';
progressBar.style.width = percent + '%';
}

function addLog(message, isError = false) {
_logQueue.push({ message, isError });
if (!_logRafId) {
_logRafId = requestAnimationFrame(() => {
_logRafId = null;
const fragment = document.createDocumentFragment();
_logQueue.splice(0).forEach(({ message, isError }) => {
const logEntry = document.createElement('div');
logEntry.textContent = `> ${message}`;
logEntry.className = isError ? 'text-red-600' : 'text-gray-600';
fragment.appendChild(logEntry);
});
progressLog.appendChild(fragment); // 一次 DOM 操作插入所有日志
progressLog.scrollTop = progressLog.scrollHeight; // 一次滚动
});
}
}

async function handleDownload() {
// 批量模式：下载所有翻译后的文件
if (isBatchMode && translatedEpubList.length > 0) {
try {
addLog(`开始打包 ${translatedEpubList.length} 个翻译文件...`);

// 创建新的ZIP文件，包含所有翻译后的EPUB
const batchZip = new JSZip();

const sourceLang = document.querySelector('input[name="sourceLang"]:checked').value;
const targetLang = document.querySelector('input[name="targetLang"]:checked').value;

// 将每个翻译后的EPUB添加到ZIP中
for (let i = 0; i < translatedEpubList.length; i++) {
const fileData = translatedEpubList[i];
const arrayBuffer = await fileData.translatedEpub.generateAsync({ type: 'uint8array' }); // 直接生成，避免 blob→arrayBuffer 中间转换

// 生成文件名: 原文件名_ZHtoEN_translated.epub
const originalName = fileData.fileName.replace('.epub', '');
const newName = `${originalName}_${LANG_CODES[sourceLang]}to${LANG_CODES[targetLang]}_translated.epub`;

batchZip.file(newName, arrayBuffer);
addLog(`  -> 添加文件: ${newName}`);
}

// 生成ZIP文件
addLog('正在生成ZIP文件...');
const zipContent = await batchZip.generateAsync({ type: 'blob' });
const url = URL.createObjectURL(zipContent);
const a = document.createElement('a');
a.href = url;
a.download = `epub_translated_batch_${translatedEpubList.length}files.zip`;
document.body.appendChild(a);
a.click();
document.body.removeChild(a);
URL.revokeObjectURL(url);

addLog(`✓ 批量下载完成: epub_translated_batch_${translatedEpubList.length}files.zip`);
addLog(`✓ 共包含 ${translatedEpubList.length} 个翻译后的EPUB文件`);
} catch (error) {
addLog('批量下载失败: ' + error.message, true);
console.error(error);
}
return;
}

// 单文件模式：原有流程
if (!translatedEpub) return;

try {
const content = await translatedEpub.generateAsync({ type: 'blob' });
const url = URL.createObjectURL(content);
const a = document.createElement('a');
a.href = url;

// 生成新的文件名，保留原文件名并添加翻译标记
const originalName = epubFile.name.replace('.epub', '');
const sourceLang = document.querySelector('input[name="sourceLang"]:checked').value;
const targetLang = document.querySelector('input[name="targetLang"]:checked').value;

// 生成格式: 原文件名_ZHtoEN_translated.epub
const newName = `${originalName}_${LANG_CODES[sourceLang]}to${LANG_CODES[targetLang]}_translated.epub`;

a.download = newName;
document.body.appendChild(a);
a.click();
document.body.removeChild(a);
URL.revokeObjectURL(url);
addLog(`✓ 翻译后文件已下载: ${newName}`);
addLog('✓ 原始文件未被修改');
} catch (error) {
addLog('下载失败: ' + error.message, true);
}
}

// 预览功能
async function showPreview() {
if (!translatedEpub) return;

try {
// 收集所有HTML文件
previewPages = [];
const files = Object.keys(translatedEpub.files);

for (const filename of files) {
if (filename.endsWith('.html') || filename.endsWith('.xhtml')) {
const file = translatedEpub.files[filename];
if (!file.dir) {
const content = await file.async('string');
previewPages.push({
filename: filename,
content: content
});
}
}
}

if (previewPages.length === 0) {
alert('未找到可预览的内容');
return;
}

currentPreviewPage = 0;
updatePreviewDisplay();

// 显示预览模态框
document.getElementById('previewModal').classList.remove('hidden');

} catch (error) {
console.error('预览失败:', error);
alert('预览失败: ' + error.message);
}
}

function updatePreviewDisplay() {
const page = previewPages[currentPreviewPage];
const previewContent = document.getElementById('previewContent');
const pageInfo = document.getElementById('pageInfo');
const previewInfo = document.getElementById('previewInfo');
const prevBtn = document.getElementById('prevPage');
const nextBtn = document.getElementById('nextPage');

// 使用 blob URL 显示内容，避免 srcdoc 的沙箱问题
try {
// 添加基本样式以确保预览效果
const safeContent = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            padding: 20px;
            line-height: 1.6;
        }
        img {
            max-width: 100%;
            height: auto;
        }
    </style>
</head>
<body>
    ${page.content}
</body>
</html>
`;
// 创建 blob URL
const blob = new Blob([safeContent], { type: 'text/html' });
const url = URL.createObjectURL(blob);
previewContent.src = url;

// 清理旧的 URL（如果有）
if (previewContent.dataset.blobUrl) {
URL.revokeObjectURL(previewContent.dataset.blobUrl);
}
previewContent.dataset.blobUrl = url;
} catch (error) {
// 如果失败，显示错误信息
console.error('预览加载失败:', error);
previewContent.textContent = '预览内容加载失败: ' + error.message;
}

// 更新页面信息
pageInfo.textContent = `第 ${currentPreviewPage + 1}/${previewPages.length} 页`;
previewInfo.textContent = `文件: ${page.filename}`;

// 更新按钮状态
prevBtn.disabled = currentPreviewPage === 0;
nextBtn.disabled = currentPreviewPage === previewPages.length - 1;

// 滚动到顶部（对 iframe 不需要，但保留以防后续改为 div）
// previewContent.scrollTop = 0;
}

function closePreview() {
document.getElementById('previewModal').classList.add('hidden');
previewPages = [];
currentPreviewPage = 0;
}

function prevPreviewPage() {
if (currentPreviewPage > 0) {
currentPreviewPage--;
updatePreviewDisplay();
}
}

function nextPreviewPage() {
if (currentPreviewPage < previewPages.length - 1) {
currentPreviewPage++;
updatePreviewDisplay();
}
}

// 中文转中文：只做格式转换，不翻译
async function handleChineseToChineseConversion() {
try {
// Reset UI and state
progressArea.classList.remove('hidden');
downloadArea.classList.add('hidden');
progressLog.innerHTML = '';
translateBtn.disabled = true;
translateBtn.classList.add('hidden');
cancelBtn.classList.remove('hidden');
cancelBtn.disabled = false;
cancelBtn.innerHTML = '<span class="flex items-center justify-center"><svg class="h-5 w-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>取消处理</span>';
isTranslating = true;
shouldCancel = false;

addLog('📌 开始处理中文EPUB（格式转换模式）');

// 检查是否启用了竖排转换
const convertCheckbox = document.getElementById('convertToHorizontal');
const shouldConvert = convertCheckbox && convertCheckbox.checked;

if (shouldConvert) {
addLog('✓ 已启用竖排转横排转换');
} else {
addLog('ℹ️ 未启用格式转换，直接复制文件');
}

// Create new zip for processed content
translatedEpub = new JSZip();

// Copy and process all files
const files = Object.keys(epubZip.files);
let processedFiles = 0;

for (const filename of files) {
// 检查是否需要取消
if (shouldCancel) {
addLog('⚠️ 处理已取消', true);
isTranslating = false;
translateBtn.disabled = false;
translateBtn.classList.remove('hidden');
cancelBtn.classList.add('hidden');
return;
}

const file = epubZip.files[filename];
if (!file.dir) {
const content = await file.async('arraybuffer');
const progress = Math.round((processedFiles / files.length) * 100);
updateProgress(`处理中... ${progress}%`, progress);

if (filename.endsWith('.html') || filename.endsWith('.xhtml')) {
// 处理HTML文件
addLog(`处理文件: ${filename}`);
const textContent = new TextDecoder().decode(content);

if (shouldConvert) {
// 转换竖排为横排
const convertedText = convertVerticalToHorizontal(textContent);
await translatedEpub.file(filename, convertedText);
addLog(`  -> ✓ 已处理（格式转换）`);
} else {
// 直接复制
await translatedEpub.file(filename, textContent);
addLog(`  -> ✓ 已复制`);
}
} else if (filename.endsWith('.opf')) {
// 处理OPF文件
addLog(`处理元数据: ${filename}`);
let opfContent = new TextDecoder().decode(content);

if (shouldConvert) {
// 转换OPF中的竖排属性
const opfPageProgressionDouble = (opfContent.match(/page-progression-direction\s*=\s*"rtl"/gi) || []).length;
const opfPageProgressionSingle = (opfContent.match(/page-progression-direction\s*=\s*'rtl'/gi) || []).length;
const totalPageProgression = opfPageProgressionDouble + opfPageProgressionSingle;

if (totalPageProgression > 0) {
if (opfPageProgressionDouble > 0) {
opfContent = opfContent.replace(
/page-progression-direction\s*=\s*"rtl"/gi,
'page-progression-direction="ltr"'
);
}
if (opfPageProgressionSingle > 0) {
opfContent = opfContent.replace(
/page-progression-direction\s*=\s*'rtl'/gi,
"page-progression-direction='ltr'"
);
}
addLog(`  -> ✓ 转换OPF页面方向: ${totalPageProgression} 个`);
}

const renditionOriDouble = (opfContent.match(/rendition:orientation\s*=\s*"vertical"/gi) || []).length;
const renditionOriSingle = (opfContent.match(/rendition:orientation\s*=\s*'vertical'/gi) || []).length;
const totalRenditionOri = renditionOriDouble + renditionOriSingle;

if (totalRenditionOri > 0) {
if (renditionOriDouble > 0) {
opfContent = opfContent.replace(
/rendition:orientation\s*=\s*"vertical"/gi,
'rendition:orientation="auto"'
);
}
if (renditionOriSingle > 0) {
opfContent = opfContent.replace(
/rendition:orientation\s*=\s*'vertical'/gi,
"rendition:orientation='auto'"
);
}
addLog(`  -> ✓ 移除竖排方向属性: ${totalRenditionOri} 个`);
}
}

await translatedEpub.file(filename, opfContent);
addLog(`  -> ✓ 已处理`);
} else if (filename.endsWith('.css')) {
// 处理CSS文件
addLog(`处理CSS文件: ${filename}`);
const cssContent = new TextDecoder().decode(content);

if (shouldConvert) {
const convertedCss = convertVerticalToHorizontal(cssContent);
await translatedEpub.file(filename, convertedCss);
addLog(`  -> ✓ 已处理（格式转换）`);
} else {
await translatedEpub.file(filename, cssContent);
addLog(`  -> ✓ 已复制`);
}
} else if (filename.endsWith('.ncx')) {
// 处理NCX文件
addLog(`处理NCX文件: ${filename}`);
const ncxContent = new TextDecoder().decode(content);

if (shouldConvert) {
const convertedNcx = convertVerticalToHorizontal(ncxContent);
await translatedEpub.file(filename, convertedNcx);
addLog(`  -> ✓ 已处理（格式转换）`);
} else {
await translatedEpub.file(filename, ncxContent);
addLog(`  -> ✓ 已复制`);
}
} else {
// Copy other files as-is
await translatedEpub.file(filename, content);
}
}

processedFiles++;
}

updateProgress('完成', 100);
addLog('✓ 处理完成！');

// 更新文件列表状态
if (fileListData.length > 0) {
	updateFileStatus(0, 'completed');
}

// Show download button
downloadArea.classList.remove('hidden');
translateBtn.disabled = false;
translateBtn.classList.remove('hidden');
cancelBtn.classList.add('hidden');
isTranslating = false;

} catch (error) {
addLog('处理过程中出错: ' + error.message, true);
translateBtn.disabled = false;
translateBtn.classList.remove('hidden');
cancelBtn.classList.add('hidden');
isTranslating = false;
}
}

// 绑定预览相关事件
