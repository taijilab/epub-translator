(() => {
    const categories = new Set(['人名', '公司名', '产品名', '地名', '技术术语']);
    const books = new Map();
    const value = id => document.getElementById(id)?.value || '';
    let renderTimer = null, page = 0, renderCount = 0;
    const storageKey = book => `epub-confirmed-terms-v1:${JSON.stringify([book.name, book.sourceLang, book.targetLang])}`;
    const pairKey = entry => JSON.stringify([entry.source, entry.target]);
    function persist(book, confirmed = book.confirmed, manual = book.manual) {
        const version = book.version + 1;
        localStorage.setItem(storageKey(book), JSON.stringify({ version, entries: [...confirmed.values()], manual: [...manual.values()] }));
        book.confirmed = confirmed; book.manual = manual; book.version = version;
    }
    function checkedEntry(raw) {
        if (!raw || typeof raw !== 'object') throw new Error('术语条目必须为对象');
        const field = name => {
            const text = raw[name];
            if (typeof text !== 'string' || !text.trim() || text.length > 2000 || /[\u0000-\u001f]/.test(text)) throw new Error('原文和译文须为非空单行文本，最多2000字符');
            return text.trim();
        };
        const category = raw.category || '技术术语';
        if (!categories.has(category)) throw new Error(`不支持的分类：${category}`);
        if (raw.aliases !== undefined && (!Array.isArray(raw.aliases) || raw.aliases.length > 50)) throw new Error('简称必须为数组，最多50条');
        const source = field('source'), target = field('target');
        const aliases = (raw.aliases || []).map(alias => { const entry = checkedEntry({ ...alias, aliases: [], category }); return { source: entry.source, target: entry.target }; });
        if (new Set([source, ...aliases.map(alias => alias.source)]).size !== aliases.length + 1) throw new Error('原文和简称不能重复');
        if (raw.chapters !== undefined && (!Array.isArray(raw.chapters) || raw.chapters.length > 5000 || raw.chapters.some(chapter => typeof chapter !== 'string' || chapter.length > 2000))) throw new Error('出现章节须为文本数组');
        return { source, target, category, aliases, chapters: [...new Set(raw.chapters || [])] };
    }
    function combinedEntries(book) {
        const entries = new Map([...book.terms.values()].map(entry => [pairKey(entry), entry]));
        for (const entry of book.manual.values()) for (const pair of [entry, ...entry.aliases]) entries.set(pairKey(pair), { ...pair, category: entry.category, chapters: new Set(entry.chapters || []) });
        return [...entries.values()];
    }
    function ensureBook(name, sourceLang, targetLang) {
        let book = books.get(name);
        if (!book || book.sourceLang !== sourceLang || book.targetLang !== targetLang) {
            book = { name, sourceLang, targetLang, terms: new Map(), manual: new Map(), confirmed: new Map(), version: 0 };
            try {
                const saved = JSON.parse(localStorage.getItem(storageKey(book)) || 'null');
                if (Array.isArray(saved?.entries)) for (const entry of saved.entries) {
                    if (typeof entry.source === 'string' && typeof entry.target === 'string' && entry.source.trim() && entry.target.trim()) {
                        book.confirmed.set(entry.source, { ...entry, aliases: (entry.aliases || []).filter(alias => typeof alias.source === 'string' && typeof alias.target === 'string' && alias.source.trim() && alias.target.trim()) });
                    }
                }
                book.version = Number(saved?.version) || 0;
                if (Array.isArray(saved?.manual)) for (const raw of saved.manual) {
                    const entry = checkedEntry(raw); book.manual.set(pairKey(entry), entry);
                }
            } catch { /* Damaged preferences do not prevent translation. */ }
            books.set(name, book);
        }
        return book;
    }
    function confirmedSnapshot(book) {
        const entries = [...book.confirmed.values()].flatMap(entry => [entry, ...entry.aliases].map(({ source, target }) => Object.freeze({ source, target })));
        return Object.freeze({ version: book.version, entries: Object.freeze(entries.sort((a, b) => a.source.localeCompare(b.source))) });
    }
    function prepare(name, sourceLang, targetLang) {
        const book = ensureBook(name, sourceLang, targetLang); scheduleRender(); return confirmedSnapshot(book);
    }
    function confirm(name, source, target, aliases = [], category = '技术术语') {
        const book = books.get(name);
        if (!book) throw new Error('请先选择书籍');
        source = source.trim(); target = target.trim();
        if (!source || !target) throw new Error('原文和译文不能为空');
        aliases = aliases.map(alias => ({ source: alias.source.trim(), target: alias.target.trim() }));
        const proposed = [source, ...aliases.map(alias => alias.source)];
        if (aliases.some(alias => !alias.source || !alias.target) || new Set(proposed).size !== proposed.length) throw new Error('简称的原文和译文不能为空，原文不能重复');
        for (const entry of book.confirmed.values()) if (entry.source !== source && [entry.source, ...entry.aliases.map(alias => alias.source)].some(key => proposed.includes(key))) throw new Error('该原文或简称已属于另一条已确认术语');
        const confirmed = new Map(book.confirmed);
        confirmed.set(source, { source, target, category, aliases });
        persist(book, confirmed); flush();
        return confirmedSnapshot(book);
    }
    function unconfirm(name, source) {
        const book = books.get(name); if (!book?.confirmed.has(source)) return;
        const confirmed = new Map(book.confirmed); confirmed.delete(source);
        persist(book, confirmed); flush();
    }
    function saveTerm(name, previous, raw, approved) {
        const book = books.get(name); if (!book) throw new Error('请先选择书籍');
        const entry = checkedEntry({ ...raw, chapters: previous?.chapters || raw.chapters || [] }), confirmed = new Map(book.confirmed), manual = new Map(book.manual);
        if (previous) {
            manual.delete(pairKey(previous));
            if (confirmed.get(previous.source)?.target === previous.target) confirmed.delete(previous.source);
        }
        if (approved) {
            const proposed = [entry.source, ...entry.aliases.map(alias => alias.source)];
            for (const other of confirmed.values()) if ([other.source, ...other.aliases.map(alias => alias.source)].some(source => proposed.includes(source))) throw new Error('原文或简称已被另一条确认术语使用，请先编辑该条目');
            confirmed.set(entry.source, entry);
        }
        manual.set(pairKey(entry), entry);
        persist(book, confirmed, manual);
        if (previous) for (const [key, observed] of book.terms) if (pairKey(observed) === pairKey(previous)) book.terms.delete(key);
        flush(); return snapshot(name);
    }
    function parseImport(text, name) {
        const book = books.get(name); if (!book) throw new Error('请先选择一本 EPUB');
        if (typeof text !== 'string' || text.length > 5 * 1024 * 1024) throw new Error('文件不能超过5MB');
        let data; try { data = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('不是有效的 JSON 手册'); }
        const rows = Array.isArray(data) ? data : data?.terms;
        if (!Array.isArray(rows) || rows.length > 5000) throw new Error('手册须包含 terms 数组或为术语数组，最多5000条');
        for (const language of ['sourceLang', 'targetLang']) if (!Array.isArray(data) && data[language] && data[language] !== book[language]) throw new Error('手册的翻译方向与当前书籍不一致');
        if (data.confirmed !== undefined && (!Array.isArray(data.confirmed) || data.confirmed.length > 5000)) throw new Error('confirmed 须为数组，最多5000条');
        const entries = rows.map(checkedEntry);
        const confirmed = (data.confirmed || rows.filter(row => row.status === '已确认')).map(checkedEntry);
        return { entries, confirmed, name: typeof data.name === 'string' ? data.name : '', book: name, sourceLang: book.sourceLang, targetLang: book.targetLang };
    }
    function importTerms(name, parsed, applyConfirmed = false) {
        const book = books.get(name); if (!book || parsed.book !== name) throw new Error('导入目标书籍已改变，请重新选择文件');
        if (parsed.sourceLang !== book.sourceLang || parsed.targetLang !== book.targetLang) throw new Error('翻译方向已改变，请重新导入');
        const confirmed = new Map(book.confirmed), manual = new Map(book.manual);
        let added = 0, skipped = 0, approved = 0, conflicts = 0;
        const existing = new Set(combinedEntries(book).map(pairKey));
        const incoming = new Map([...parsed.entries, ...parsed.confirmed].map(entry => [pairKey(entry), entry]));
        for (const entry of incoming.values()) {
            if (existing.has(pairKey(entry))) { skipped++; continue; }
            manual.set(pairKey(entry), entry); existing.add(pairKey(entry)); added++;
        }
        if (applyConfirmed) for (const entry of parsed.confirmed) {
            const proposed = [entry.source, ...entry.aliases.map(alias => alias.source)];
            const same = confirmed.get(entry.source);
            if (same?.target === entry.target && entry.aliases.every(alias => same.aliases.some(other => pairKey(other) === pairKey(alias)))) continue;
            if ([...confirmed.values()].some(other => [other.source, ...other.aliases.map(alias => alias.source)].some(source => proposed.includes(source)))) { conflicts++; continue; }
            confirmed.set(entry.source, entry); approved++;
        }
        persist(book, confirmed, manual); page = 0; flush();
        return { added, skipped, approved, conflicts };
    }
    function scheduleRender() { if (renderTimer === null) renderTimer = setTimeout(flush, 80); }
    function flush() { clearTimeout(renderTimer); renderTimer = null; render(); }
    function startRun() { for (const book of books.values()) book.terms.clear(); flush(); }
    function contains(text, term) {
        if (!term) return false;
        let offset = 0;
        while ((offset = text.indexOf(term, offset)) !== -1) {
            const before = [...text.slice(0, offset)].at(-1) || '';
            const after = [...text.slice(offset + term.length)][0] || '';
            // CJK prose does not require spaces around Latin names such as OpenAI.
            const word = character => /[\p{L}\p{M}\p{N}_]/u.test(character) &&
                !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(character);
            if ((!/^[A-Za-z0-9_]/.test(term) || !word(before)) &&
                (!/[A-Za-z0-9_]$/.test(term) || !word(after))) return true;
            offset += term.length;
        }
        return false;
    }
    function reset() { books.clear(); page = 0; flush(); }
    function validate(entries, original, translated) {
        if (!Array.isArray(entries)) return [];
        const seen = new Set();
        return entries.filter(entry => {
            if (!entry || !categories.has(entry.category) || typeof entry.source !== 'string' || typeof entry.target !== 'string') return false;
            if (!entry.source.trim() || !entry.target.trim() || !contains(original, entry.source) || !contains(translated, entry.target)) return false;
            const key = JSON.stringify([entry.category, entry.source, entry.target]);
            if (seen.has(key)) return false;
            seen.add(key); return true;
        }).map(({ category, source, target }) => ({ category, source, target }));
    }
    function add(context, entries, sourceLang, targetLang) {
        const name = context.file || '未命名书籍';
        const book = ensureBook(name, sourceLang, targetLang);
        for (const entry of entries) {
            const key = JSON.stringify([entry.category, entry.source.normalize('NFKC').toLowerCase(), entry.target]);
            if (!book.terms.has(key)) book.terms.set(key, { ...entry, chapters: new Set() });
            if (context.chapter) book.terms.get(key).chapters.add(context.chapter);
        }
        scheduleRender();
    }
    function snapshot(name) {
        const book = books.get(name);
        if (!book) return null;
        const confirmed = confirmedSnapshot(book);
        const entries = combinedEntries(book).map(entry => ({ ...entry, chapters: [...entry.chapters].sort() }));
        const observed = new Set(entries.map(entry => JSON.stringify([entry.source, entry.target])));
        for (const entry of book.confirmed.values()) for (const pair of [entry, ...entry.aliases]) if (!observed.has(JSON.stringify([pair.source, pair.target]))) entries.push({ ...pair, category: entry.category, chapters: [] });
        const variants = new Map(), approved = new Map(confirmed.entries.map(entry => [entry.source, entry.target]));
        for (const entry of entries) {
            if (!variants.has(entry.source)) variants.set(entry.source, new Set());
            variants.get(entry.source).add(entry.target);
        }
        return { name: book.name, sourceLang: book.sourceLang, targetLang: book.targetLang, version: book.version, confirmed: [...book.confirmed.values()],
            terms: entries.map(entry => ({ ...entry, status: approved.get(entry.source) === entry.target ? '已确认' : variants.get(entry.source).size > 1 || approved.has(entry.source) ? '冲突' : '候选' })) };
    }
    function glossaryFor(name, text, frozen) {
        const book = books.get(name); if (!book) return [];
        const chosen = new Map(), conflicts = new Set();
        for (const entry of combinedEntries(book)) {
            if (!contains(text, entry.source)) continue;
            if (chosen.has(entry.source) && chosen.get(entry.source).target !== entry.target) conflicts.add(entry.source);
            else chosen.set(entry.source, { source: entry.source, target: entry.target });
        }
        const confirmed = frozen?.entries || confirmedSnapshot(book).entries;
        return selectTerms(text, [...confirmed, ...[...chosen.values()].filter(entry => !conflicts.has(entry.source))]);
    }
    function selectTerms(text, entries) {
        const unique = new Map();
        for (const entry of entries) if (!unique.has(entry.source)) unique.set(entry.source, entry);
        const occupied = [], result = [];
        for (const entry of [...unique.values()].sort((a, b) => b.source.length - a.source.length)) {
            let offset = 0, used = false;
            while ((offset = text.indexOf(entry.source, offset)) !== -1) {
                const end = offset + entry.source.length;
                // Check boundaries against the original text, not a truncated suffix.
                const before = text.slice(Math.max(0, offset - 2), offset), after = text.slice(end, end + 2);
                if (contains(`${before}${entry.source}${after}`, entry.source) && !occupied.some(([start, stop]) => offset < stop && end > start)) { occupied.push([offset, end]); used = true; }
                offset = end;
            }
            if (used) result.push({ source: entry.source, target: entry.target });
        }
        return result.slice(0, 100);
    }
    const cell = text => { const td = document.createElement('td'); td.className = 'p-2 align-top break-words'; td.textContent = text; return td; };
    function render() {
        const panel = document.getElementById('namedTermsPanel');
        if (!panel) return;
        renderCount++;
        panel.classList.toggle('hidden', !books.size);
        const select = document.getElementById('termsBook'), selected = select.value;
        select.replaceChildren();
        for (const name of books.keys()) { const option = document.createElement('option'); option.value = name; option.textContent = name; select.appendChild(option); }
        if (books.has(selected)) select.value = selected;
        const book = snapshot(select.value), query = value('termsSearch').toLowerCase(), category = value('termsCategory');
        const entries = book?.terms.filter(entry => (!category || entry.category === category) && (!value('termsStatus') || entry.status === value('termsStatus')) && `${entry.source}\n${entry.target}`.toLowerCase().includes(query)) || [];
        page = Math.min(page, Math.max(0, Math.ceil(entries.length / 50) - 1));
        const rows = document.getElementById('termsRows'); rows.replaceChildren();
        for (const entry of entries.slice(page * 50, (page + 1) * 50)) {
            const row = document.createElement('tr'); row.className = 'border-b border-gray-100';
            const action = cell(''), button = document.createElement('button');
            button.type = 'button'; button.textContent = '编辑'; button.className = 'text-blue-700 whitespace-nowrap';
            button.addEventListener('click', () => edit(entry)); action.append(button);
            row.append(cell(entry.category), cell(entry.source), cell(entry.target), cell(entry.status), cell(entry.chapters.join(', ')), action); rows.appendChild(row);
        }
        document.getElementById('termsSummary').textContent = book ? `${book.sourceLang} → ${book.targetLang}；${book.terms.length} 条术语，已确认版本 ${book.version}，筛选 ${entries.length} 条，第 ${page + 1}/${Math.max(1, Math.ceil(entries.length / 50))} 页` : '';
        if (document.getElementById('termsPrevious')) document.getElementById('termsPrevious').disabled = page === 0;
        if (document.getElementById('termsNext')) document.getElementById('termsNext').disabled = (page + 1) * 50 >= entries.length;
        document.getElementById('termsDownload').disabled = !book?.terms.length;
        document.getElementById('termsDownloadJson').disabled = !book?.terms.length;
    }
    function edit(entry = {}) {
        const matches = item => pairKey(item) === pairKey(entry) || item.aliases.some(alias => pairKey(alias) === pairKey(entry));
        const canonical = [...(books.get(value('termsBook'))?.confirmed.values() || [])].find(matches);
        const manual = [...(books.get(value('termsBook'))?.manual.values() || [])].find(matches);
        const owner = canonical || manual || entry;
        document.getElementById('termSource').value = owner.source || '';
        document.getElementById('termTarget').value = owner.target || '';
        document.getElementById('termAliases').value = (owner.aliases || []).map(alias => `${alias.source}=${alias.target}`).join('\n');
        document.getElementById('termEditorError').textContent = '';
        document.getElementById('termEditor').dataset.category = canonical?.category || entry.category || '技术术语';
        document.getElementById('termEditor').dataset.originalSource = canonical?.source || '';
        document.getElementById('termEditor').dataset.previous = entry.source ? JSON.stringify(owner) : '';
        document.getElementById('termEditor').dataset.book = value('termsBook');
        document.getElementById('termSource').readOnly = false;
        document.getElementById('termCategory').value = canonical?.category || entry.category || '技术术语';
        document.getElementById('termConfirmed').checked = !!canonical || !entry.source;
        document.getElementById('termUnconfirm').disabled = !canonical;
        document.getElementById('termEditor').showModal();
    }
    const escape = text => String(text).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
    function markdown(book) {
        return `# ${escape(book.name)} 专有名词手册\n\n已确认版本：${book.version || 0}\n\n| 分类 | 原文 | 译文 | 状态 | 出现章节 |\n|---|---|---|---|---|\n` + book.terms.map(entry => `| ${escape(entry.category)} | ${escape(entry.source)} | ${escape(entry.target)} | ${escape(entry.status || '候选')} | ${escape(entry.chapters.join(', '))} |`).join('\n') + '\n\n' + (book.confirmed || []).flatMap(entry => entry.aliases.map(alias => `${escape(entry.source)} 的简称：${escape(alias.source)} → ${escape(alias.target)}`)).join('\n');
    }
    function download(json) {
        const book = snapshot(value('termsBook')); if (!book) return;
        const url = URL.createObjectURL(new Blob([json ? JSON.stringify(book, null, 2) : markdown(book)], { type: json ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url;
        link.download = `${book.name.replace(/\.epub$/i, '').replace(/[\\/:*?"<>|]/g, '_')}_专有名词手册.${json ? 'json' : 'md'}`; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    document.addEventListener('DOMContentLoaded', () => {
        let pendingImport = null;
        document.getElementById('termsImport')?.addEventListener('click', () => document.getElementById('termsImportFile').click());
        document.getElementById('termsImportFile')?.addEventListener('change', async event => {
            const file = event.target.files[0], name = value('termsBook');
            event.target.value = ''; if (!file) return;
            const status = document.getElementById('termsImportStatus');
            try {
                if (file.size > 5 * 1024 * 1024) throw new Error('文件不能超过5MB');
                pendingImport = parseImport(await file.text(), name);
                if (name !== value('termsBook')) throw new Error('当前书籍已改变，请重新导入');
                document.getElementById('termsImportSummary').textContent = `目标：${name}；${pendingImport.entries.length} 条术语，${pendingImport.confirmed.length} 条已确认记录。`;
                document.getElementById('termsImportConfirmed').checked = false;
                document.getElementById('termsImportError').textContent = '';
                const rows = document.getElementById('termsImportRows'); rows.replaceChildren();
                for (const entry of pendingImport.entries.slice(0, 20)) { const row = document.createElement('tr'); row.append(cell(entry.category), cell(entry.source), cell(entry.target)); rows.append(row); }
                document.getElementById('termsImporter').showModal();
            } catch (error) { pendingImport = null; status.textContent = `导入失败：${error.message}`; }
        });
        document.getElementById('termsImportCancel')?.addEventListener('click', () => { pendingImport = null; document.getElementById('termsImporter').close(); });
        document.getElementById('termsImportApply')?.addEventListener('click', () => {
            try {
                if (!pendingImport) throw new Error('请重新选择手册');
                const result = importTerms(value('termsBook'), pendingImport, document.getElementById('termsImportConfirmed').checked);
                document.getElementById('termsImportStatus').textContent = `导入完成：新增 ${result.added} 条，重复跳过 ${result.skipped} 条，启用确认 ${result.approved} 条，已有确认冲突保留 ${result.conflicts} 条。`;
                pendingImport = null; document.getElementById('termsImporter').close();
            } catch (error) { document.getElementById('termsImportError').textContent = error.message; }
        });
        const prepareFiles = () => {
            const source = document.querySelector('input[name="sourceLang"]:checked')?.value || 'en';
            const target = document.querySelector('input[name="targetLang"]:checked')?.value || 'zh';
            const names = new Set([...books.keys(), ...[...(document.getElementById('fileInput')?.files || [])].map(file => file.name)]);
            for (const name of names) prepare(name, source, target);
        };
        document.getElementById('fileInput')?.addEventListener('change', prepareFiles);
        document.querySelectorAll('input[name="sourceLang"],input[name="targetLang"]').forEach(input => input.addEventListener('change', prepareFiles));
        document.getElementById('termsNew')?.addEventListener('click', () => edit());
        document.getElementById('termCancel')?.addEventListener('click', () => document.getElementById('termEditor').close());
        document.getElementById('termUnconfirm')?.addEventListener('click', () => {
            try { unconfirm(document.getElementById('termEditor').dataset.book, document.getElementById('termEditor').dataset.originalSource); document.getElementById('termEditor').close(); }
            catch (error) { document.getElementById('termEditorError').textContent = error.message; }
        });
        document.getElementById('termSave')?.addEventListener('click', () => {
            try {
                const aliases = value('termAliases').split('\n').filter(line => line.trim()).map(line => { const at = line.indexOf('='); if (at < 1) throw new Error('简称格式为 原文=译文'); return { source: line.slice(0, at), target: line.slice(at + 1) }; });
                const editor = document.getElementById('termEditor');
                saveTerm(editor.dataset.book, editor.dataset.previous ? JSON.parse(editor.dataset.previous) : null, { source: value('termSource'), target: value('termTarget'), aliases, category: value('termCategory') }, document.getElementById('termConfirmed').checked);
                document.getElementById('termEditor').close();
            } catch (error) { document.getElementById('termEditorError').textContent = error.message; }
        });
        document.getElementById('termsPrevious')?.addEventListener('click', () => { page--; flush(); });
        document.getElementById('termsNext')?.addEventListener('click', () => { page++; flush(); });
        document.getElementById('termsStatus')?.addEventListener('change', () => { page = 0; flush(); });
        document.getElementById('termsBook')?.addEventListener('change', () => { page = 0; flush(); });
        document.getElementById('termsCategory')?.addEventListener('change', () => { page = 0; flush(); });
        document.getElementById('termsSearch')?.addEventListener('input', () => { page = 0; flush(); });
        document.getElementById('termsDownload')?.addEventListener('click', () => download(false));
        document.getElementById('termsDownloadJson')?.addEventListener('click', () => download(true));
    });
    window.NamedTerms = { reset, startRun, prepare, confirm, unconfirm, saveTerm, parseImport, importTerms, freezeAll: (sourceLang, targetLang) => new Map([...books].filter(([, book]) => book.sourceLang === sourceLang && book.targetLang === targetLang).map(([name, book]) => [name, confirmedSnapshot(book)])), confirmedSnapshot: name => books.has(name) ? confirmedSnapshot(books.get(name)) : null, validate, add, snapshot, markdown, glossaryFor, contains, selectTerms, flush, renderCount: () => renderCount };
})();
