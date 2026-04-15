// ============================================================
// IndexedDB 持久化层 - 翻译缓存 + 文件进度
// ============================================================

const DB_NAME = 'epub-translator-v4';
const DB_VERSION = 1;
const STORE_CACHE = 'cache';
const STORE_PROGRESS = 'progress';

// 缓存条目上限（IndexedDB）
const PERSISTENT_CACHE_LIMIT = 50000;
// 单次启动预加载到内存的条目数
const PRELOAD_CACHE_LIMIT = 5000;

let dbPromise = null;

// 打开/升级数据库
function openDB() {
if (dbPromise) return dbPromise;
dbPromise = new Promise((resolve, reject) => {
if (!window.indexedDB) {
console.warn('IndexedDB 不可用，持久化功能禁用');
reject(new Error('IndexedDB unavailable'));
return;
}
const req = indexedDB.open(DB_NAME, DB_VERSION);
req.onupgradeneeded = (e) => {
const db = e.target.result;
if (!db.objectStoreNames.contains(STORE_CACHE)) {
const store = db.createObjectStore(STORE_CACHE, { keyPath: 'key' });
store.createIndex('accessedAt', 'accessedAt');
}
if (!db.objectStoreNames.contains(STORE_PROGRESS)) {
const store = db.createObjectStore(STORE_PROGRESS, { keyPath: 'fileId' });
store.createIndex('updatedAt', 'updatedAt');
}
};
req.onsuccess = (e) => resolve(e.target.result);
req.onerror = (e) => reject(e.target.error);
});
return dbPromise;
}

// 生成文件指纹（快速、稳定）
async function computeFileId(file) {
const header = `${file.name}::${file.size}::${file.lastModified}`;
if (!crypto?.subtle) {
return 'fid-' + fnv1aHash(header);
}
try {
// 读取文件头尾各 4KB 做 hash，不读整个大文件
const sampleSize = 4096;
const head = await file.slice(0, sampleSize).arrayBuffer();
const tail = await file.slice(Math.max(0, file.size - sampleSize)).arrayBuffer();
const headHash = await crypto.subtle.digest('SHA-256', head);
const tailHash = await crypto.subtle.digest('SHA-256', tail);
const hex = (buf) => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
return `fid-${file.size}-${hex(headHash).slice(0, 16)}-${hex(tailHash).slice(0, 16)}`;
} catch (e) {
return 'fid-' + fnv1aHash(header);
}
}

// 批量保存缓存条目（用于持久化内存中的缓存）
async function persistCacheEntries(entries) {
try {
const db = await openDB();
const tx = db.transaction(STORE_CACHE, 'readwrite');
const store = tx.objectStore(STORE_CACHE);
const now = Date.now();
for (const [key, value] of entries) {
store.put({ key, value, accessedAt: now });
}
await new Promise((resolve, reject) => {
tx.oncomplete = resolve;
tx.onerror = () => reject(tx.error);
});
} catch (e) {
// 静默失败，不影响翻译
console.warn('缓存持久化失败:', e.message);
}
}

// 单条保存（节流后调用）
let pendingCacheWrites = new Map();
let cacheFlushTimer = null;
function enqueueCacheWrite(key, value) {
pendingCacheWrites.set(key, value);
if (cacheFlushTimer) return;
cacheFlushTimer = setTimeout(() => {
const batch = Array.from(pendingCacheWrites.entries());
pendingCacheWrites = new Map();
cacheFlushTimer = null;
persistCacheEntries(batch);
}, 2000); // 2秒批量写入一次
}

// 启动时预加载缓存
async function preloadCache(targetMap) {
try {
const db = await openDB();
const tx = db.transaction(STORE_CACHE, 'readonly');
const store = tx.objectStore(STORE_CACHE);
const index = store.index('accessedAt');
// 从最新的往前读
const cursor = index.openCursor(null, 'prev');
return new Promise((resolve) => {
let loaded = 0;
cursor.onsuccess = (e) => {
const c = e.target.result;
if (c && loaded < PRELOAD_CACHE_LIMIT) {
targetMap.set(c.value.key, c.value.value);
loaded++;
c.continue();
} else {
resolve(loaded);
}
};
cursor.onerror = () => resolve(loaded);
});
} catch (e) {
console.warn('缓存预加载失败:', e.message);
return 0;
}
}

// 清理过期缓存（LRU）
async function trimCache() {
try {
const db = await openDB();
const tx = db.transaction(STORE_CACHE, 'readwrite');
const store = tx.objectStore(STORE_CACHE);
const countReq = store.count();
await new Promise((resolve) => { countReq.onsuccess = resolve; });
const count = countReq.result;
if (count <= PERSISTENT_CACHE_LIMIT) return;

const toDelete = count - PERSISTENT_CACHE_LIMIT;
const index = store.index('accessedAt');
const cursor = index.openCursor(null, 'next'); // 从最旧的开始
let deleted = 0;
await new Promise((resolve) => {
cursor.onsuccess = (e) => {
const c = e.target.result;
if (c && deleted < toDelete) {
c.delete();
deleted++;
c.continue();
} else {
resolve();
}
};
});
console.log(`缓存清理: 删除 ${deleted} 条过期条目`);
} catch (e) {
console.warn('缓存清理失败:', e.message);
}
}

// 保存文件翻译进度
async function saveFileProgress(fileId, data) {
try {
const db = await openDB();
const tx = db.transaction(STORE_PROGRESS, 'readwrite');
const store = tx.objectStore(STORE_PROGRESS);
store.put({
fileId,
...data,
updatedAt: Date.now()
});
await new Promise((resolve, reject) => {
tx.oncomplete = resolve;
tx.onerror = () => reject(tx.error);
});
} catch (e) {
console.warn('进度保存失败:', e.message);
}
}

// 读取文件翻译进度
async function getFileProgress(fileId) {
try {
const db = await openDB();
const tx = db.transaction(STORE_PROGRESS, 'readonly');
const store = tx.objectStore(STORE_PROGRESS);
const req = store.get(fileId);
return new Promise((resolve) => {
req.onsuccess = () => resolve(req.result || null);
req.onerror = () => resolve(null);
});
} catch (e) {
return null;
}
}

// 删除单个文件进度
async function deleteFileProgress(fileId) {
try {
const db = await openDB();
const tx = db.transaction(STORE_PROGRESS, 'readwrite');
tx.objectStore(STORE_PROGRESS).delete(fileId);
await new Promise((resolve, reject) => {
tx.oncomplete = resolve;
tx.onerror = () => reject(tx.error);
});
} catch (e) {
console.warn('进度删除失败:', e.message);
}
}

// 列出所有进度记录（用于历史面板）
async function listAllProgress() {
try {
const db = await openDB();
const tx = db.transaction(STORE_PROGRESS, 'readonly');
const store = tx.objectStore(STORE_PROGRESS);
const req = store.getAll();
return new Promise((resolve) => {
req.onsuccess = () => {
const all = req.result || [];
all.sort((a, b) => b.updatedAt - a.updatedAt);
resolve(all);
};
req.onerror = () => resolve([]);
});
} catch (e) {
return [];
}
}

// 清空所有缓存（用户触发）
async function clearAllCache() {
try {
const db = await openDB();
const tx = db.transaction(STORE_CACHE, 'readwrite');
tx.objectStore(STORE_CACHE).clear();
await new Promise((resolve, reject) => {
tx.oncomplete = resolve;
tx.onerror = () => reject(tx.error);
});
return true;
} catch (e) {
return false;
}
}

// 获取存储使用情况
async function getStorageInfo() {
try {
const db = await openDB();
const tx = db.transaction([STORE_CACHE, STORE_PROGRESS], 'readonly');
const cacheCount = tx.objectStore(STORE_CACHE).count();
const progressCount = tx.objectStore(STORE_PROGRESS).count();
await new Promise((resolve) => {
cacheCount.onsuccess = () => {
progressCount.onsuccess = resolve;
};
});
let quota = null;
if (navigator.storage?.estimate) {
const est = await navigator.storage.estimate();
quota = { usage: est.usage, quota: est.quota };
}
return {
cacheCount: cacheCount.result,
progressCount: progressCount.result,
quota
};
} catch (e) {
return { cacheCount: 0, progressCount: 0, quota: null };
}
}

// 导出为全局 API
window.Persistence = {
computeFileId,
preloadCache,
enqueueCacheWrite,
trimCache,
saveFileProgress,
getFileProgress,
deleteFileProgress,
listAllProgress,
clearAllCache,
getStorageInfo
};
