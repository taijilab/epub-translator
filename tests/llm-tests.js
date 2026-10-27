document.addEventListener('DOMContentLoaded', async () => {
    const results = [];
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    const test = async (name, fn) => {
        try { await fn(); results.push(`PASS ${name}`); }
        catch (error) { results.push(`FAIL ${name}: ${error.message}`); }
        document.getElementById('results').textContent = results.join('\n');
    };
    const history = [];
    const requests = [];
    const begin = () => {
        shouldCancel = false; cache.clear(); history.length = 0;
        requests.length = 0;
        document.getElementById('apiRetryLimit').value = '2';
        document.getElementById('apiRepairBudget').value = '32';
        document.getElementById('apiRepairTokens').value = '128000';
        LLM.begin('kimi', 'en', 'zh');
    };
    const context = { file: 'fixture.epub', chapter: 'chapter.xhtml' };
    const fixture = '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Title</title></head><body><p>Hello <em>world</em> <a href="#note">note</a></p><p id="note">Second</p><script>ignore()</script></body></html>';
    let calls = 0, running = 0, maxRunning = 0, behavior = 'success', payload, requestUrl;
    window.fetch = async (url, options) => {
        requestUrl = url;
        calls++; running++; maxRunning = Math.max(maxRunning, running);
        payload = JSON.parse(options.body);
        requests.push(payload);
        const items = JSON.parse(payload.messages[1].content);
        history.push(items.map(item => item.text));
        await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 20);
            options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); });
        }).finally(() => running--);
        if (behavior === 'auth') return new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401 });
        if (behavior === 'balance' || behavior === 'permission') return new Response(JSON.stringify({ error: { message: behavior } }), { status: behavior === 'balance' ? 402 : 403 });
        if (behavior === 'rate' && calls === 1) return new Response('{}', { status: 429, headers: { 'Retry-After': '0.01' } });
        if (behavior === 'stream') {
            const content = JSON.stringify(items.map(item => ({ id: item.id, text: `中文译文:${item.text}` })));
            const encoder = new TextEncoder();
            return new Response(new ReadableStream({
                async start(controller) {
                    for (const part of [content.slice(0, 45), content.slice(45)]) {
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\r\n\r\n`));
                        await new Promise(resolve => setTimeout(resolve, 10));
                    }
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 2000, prompt_tokens_details: { cached_tokens: 100 } } })}\n\ndata: [DONE]\n\n`));
                    controller.close();
                }
            }), { headers: { 'Content-Type': 'text/event-stream' } });
        }
        const translated = items.map(item => ({ id: item.id, text: item.translated || (behavior === 'glossary' ? '爱丽丝继续工作。' : `T:${item.text}`), terms: behavior === 'entities' && item.text.includes('world') ? [{ category: '产品名', source: 'world', target: 'world' }] : behavior === 'glossary' ? [{ category: '人名', source: 'Alice', target: '爱丽丝' }] : [] })).reverse();
        if (items.every(item => item.translated !== undefined) && behavior !== 'metadata-invalid') {
            const missing = new Set(behavior === 'metadata-onemissing' ? items.filter(item=>item.text.includes('Bad metadata')).map(item=>item.id) : []);
            return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(translated.filter(item=>!missing.has(item.id)).map(({id,terms})=>({id,terms})))},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5}}));
        }
        if (behavior === 'metadata-invalid') return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(items.map(item=>({id:item.id})))},finish_reason:'stop'}]}));
        const content = JSON.stringify(behavior === 'invalid' ? translated.slice(1) : behavior === 'onebad' ? translated.filter(item => !item.text.includes('Bad fragment')) : behavior === 'duplicate' ? [...translated, translated.find(item => item.text.includes('Bad fragment'))] : behavior === 'empty' ? translated.map(item => item.text.includes('Bad fragment') ? {...item,text:''} : item) : behavior === 'badmarkers' ? translated.map(item => item.text.includes('Bad fragment') ? {...item,text:item.text.replace(/\[\[EPUB_TAG_\d+\]\]/,'')} : item) : translated);
        return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: behavior === 'truncated' ? 'length' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } }));
    };
    await test('ID mapping accepts reordered results', () => {
        const mapped = LLM.validateResult('[{"id":"b","text":"B"},{"id":"a","text":"A"}]', [{ id: 'a' }, { id: 'b' }]);
        assert(mapped.get('a') === 'A', 'wrong mapping');
    });
    await test('Reject missing, duplicate, unknown IDs and empty output', () => {
        for (const content of ['[]', '[{"id":"a","text":"A"},{"id":"a","text":"B"}]', '[{"id":"a","text":"A"},{"id":"c","text":"B"}]', '[{"id":"a","text":""},{"id":"b","text":"B"}]']) {
            let rejected = false;
            try { LLM.validateResult(content, [{ id: 'a' }, { id: 'b' }]); } catch { rejected = true; }
            assert(rejected, content);
        }
    });
    await test('Kimi payload, XHTML, inline tags and reversed IDs', async () => {
        begin(); behavior = 'success';
        const output = await LLM.translate(fixture, 'en', 'zh', 'kimi', context);
        const doc = new DOMParser().parseFromString(output, 'application/xhtml+xml');
        assert(!doc.querySelector('parsererror'), 'invalid XHTML');
        assert(doc.querySelector('em').textContent === 'world', 'inline tag lost');
        assert(doc.querySelector('a').getAttribute('href') === '#note', 'link lost');
        assert(doc.querySelector('script').textContent === 'ignore()', 'script translated');
        assert(payload.model === 'kimi-k2.6' && payload.thinking.type === 'disabled' && !('temperature' in payload), 'Kimi parameters');
    });
    await test('Cache reuse and isolation across mode, glossary, model and endpoint', async () => {
        begin(); calls = 0;
        await LLM.translate(fixture, 'en', 'zh', 'kimi', context);
        await LLM.translate(fixture, 'en', 'zh', 'kimi', context);
        assert(calls === 1, 'cache miss');
        for (const [id, input] of [['kimiModel', 'other'], ['customGlossary', 'world=Earth'], ['kimiBaseUrl', 'https://example.com/v1']]) {
            document.getElementById(id).value = input; LLM.begin('kimi', 'en', 'zh');
            await LLM.translate(fixture, 'en', 'zh', 'kimi', context);
        }
        mode = 'refined'; LLM.begin('kimi', 'en', 'zh');
        await LLM.translate(fixture, 'en', 'zh', 'kimi', context);
        assert(calls === 5, 'settings did not invalidate cache');
        document.getElementById('kimiModel').value = 'kimi-k2.6';
        document.getElementById('kimiBaseUrl').value = 'https://api.moonshot.cn/v1';
        document.getElementById('customGlossary').value = ''; mode = 'standard';
    });
    await test('Concurrent chapters share one request limit', async () => {
        begin(); calls = 0; maxRunning = 0;
        await Promise.all(Array.from({ length: 8 }, (_, index) => LLM.translate(`<html><body><p>Chapter ${index}</p></body></html>`, 'en', 'zh', 'kimi', context)));
        assert(maxRunning === 2 && calls === 8, `max=${maxRunning}, calls=${calls}`);
    });
    await test('Missing IDs retain only invalid original, report context, cache valid neighbors', async () => {
        begin(); behavior = 'invalid';
        const output = await LLM.translate(fixture, 'en', 'zh', 'kimi', context);
        assert(output.includes('T:Hello') && output.includes('Second'), 'valid neighbor lost');
        assert(LLM.failureCount('fixture.epub') === 1 && cache.size === 2, 'report or cache wrong');
        assert(document.getElementById('translationFailureList').textContent.includes('chapter.xhtml'), 'missing chapter');
    });
    await test('Truncated output is rejected', async () => {
        begin(); behavior = 'truncated';
        await LLM.translate('<html><body><p>Original</p></body></html>', 'en', 'zh', 'kimi', context);
        assert(LLM.failureCount() === 1 && cache.size === 0, 'truncation accepted');
    });
    await test('401 is not retried and reports incomplete result', async () => {
        begin(); calls = 0; behavior = 'auth';
        await LLM.translate(fixture, 'en', 'zh', 'kimi', context);
        assert(calls === 1 && LLM.stopped() && LLM.completionText().includes('停止'), 'auth error hidden');
    });
    await test('429 recovers after Retry-After', async () => {
        begin(); calls = 0; behavior = 'rate';
        await LLM.translate(fixture, 'en', 'zh', 'kimi', context);
        assert(calls === 2 && LLM.failureCount() === 0, 'retry failed');
    });
    await test('TaoToken all billing paths use OpenAI payload without vendor parameters', async () => {
        begin(); behavior = 'success'; calls = 0;
        for (const base of ['https://api.taotoken.net/v1', 'https://api.taotoken.net/token/v1', 'https://api.taotoken.net/coding/v1']) {
            document.getElementById('taotokenBaseUrl').value = base;
            LLM.begin('taotoken', 'en', 'zh');
            await LLM.translate(fixture, 'en', 'zh', 'taotoken', context);
            assert(requestUrl === `${base}/chat/completions`, 'wrong billing request URL');
            assert(payload.model === 'model-from-console' && !('thinking' in payload) && !('temperature' in payload), 'wrong relay parameters');
        }
        assert(calls === 3 && LLM.failureCount() === 0, 'billing path cache isolation');
    });
    await test('Live preview and larger groups reduce short-paragraph calls', async () => {
        begin(); behavior = 'success'; calls = 0; previews.length = 0; progressUpdates.length = 0;
        const html = `<html><body>${Array.from({ length: 60 }, (_, i) => `<p>Text ${i}</p>`).join('')}</body></html>`;
        await LLM.translate(html, 'en', 'zh', 'kimi', context);
        assert(calls === 2, `expected 2 grouped requests, got ${calls}`);
        assert(previews.some(p => p.translated.includes('等待模型')) && previews.some(p => p.translated.includes('T:Text')), 'missing live comparison');
        assert(progressUpdates.length === 2 && progressUpdates.every(p => p.percent > 0 && p.percent <= 99), 'missing per-group progress');
    });
    await test('DeepSeek Flash thinking is disabled for standard, enabled for refined', async () => {
        document.getElementById('taotokenModel').value = 'deepseek-flash';
        document.getElementById('taotokenBaseUrl').value = 'https://api.taotoken.net/v1';
        for (const quality of ['standard', 'refined']) {
            mode = quality; cache.clear(); LLM.begin('taotoken', 'en', 'zh');
            await LLM.translate(fixture, 'en', 'zh', 'taotoken', context);
            assert(payload.thinking.type === (quality === 'refined' ? 'enabled' : 'disabled'), 'wrong thinking mode');
        }
        mode = 'standard'; document.getElementById('taotokenModel').value = 'model-from-console';
    });
    await test('Streamed Chinese text appears before final validation and usage is billed', async () => {
        behavior = 'stream'; previews.length = 0; cache.clear();
        document.getElementById('taotokenModel').value = 'deepseek-flash';
        LLM.begin('taotoken', 'en', 'zh');
        const output = await LLM.translate(fixture, 'en', 'zh', 'taotoken', context);
        assert(output.includes('中文译文:Hello'), 'streamed text missing');
        assert(previews.filter(p => p.translated.includes('中文译文')).length >= 2, 'no incremental display');
        const price = LLM.pricingAt();
        assert(Math.abs(LLM.costSummary().yuan - (900 * price.input + 100 * price.cached + 2000 * price.output) / 1000000) < 0.000001, 'usage cost mismatch');
        behavior = 'success'; document.getElementById('taotokenModel').value = 'model-from-console';
    });
    await test('Beijing peak/off-peak pricing boundaries', () => {
        assert(LLM.pricingAt(new Date('2026-10-14T01:00:00Z')).input === 2, '09:00 peak');
        assert(LLM.pricingAt(new Date('2026-10-14T04:00:00Z')).input === 1, '12:00 off-peak');
        assert(LLM.pricingAt(new Date('2026-10-14T06:00:00Z')).output === 8, '14:00 peak');
        assert(LLM.pricingAt(new Date('2026-10-14T10:00:00Z')).output === 4, '18:00 off-peak');
        assert(LLM.pricingAt(new Date('2026-10-17T01:00:00Z')).input === 1, 'weekend');
    });
    await test('Preview keeps text, starts at a text page, and strips scripts', async () => {
        const text = '这是译文预览的正文。'.repeat(8);
        const content = `<html><head><style>body{height:0;writing-mode:vertical-rl}</style></head><body><p onclick="alert(1)">${text}</p><script>alert(1)</script></body></html>`;
        const output = PreviewHelper.documentFor(content);
        const doc = new DOMParser().parseFromString(output, 'text/html');
        assert(doc.body.textContent === text && !doc.querySelector('script,[onclick]'), 'preview sanitizer');
        assert(PreviewHelper.firstTextPage([{ content: '<html><body><img src="cover.jpg"></body></html>' }, { content }]) === 1, 'cover selected');
        const frame = document.getElementById('previewFixture');
        await new Promise(resolve => { frame.onload = resolve; frame.srcdoc = output; });
        assert(frame.getBoundingClientRect().height >= 300, 'preview collapsed');
    });
    await test('One invalid fragment does not discard its valid neighbors; punctuation is retained', async () => {
        begin(); behavior = 'onebad';
        const html = '<html><body><p>27.</p><p>Good heading</p><p>.</p><p>Bad fragment</p><p>Good body</p></body></html>';
        const output = await LLM.translate(html, 'en', 'zh', 'kimi', context);
        const doc = new DOMParser().parseFromString(output, 'text/html');
        const paragraphs = [...doc.querySelectorAll('p')].map(p => p.textContent);
        assert(paragraphs.join('|') === '27.|T:Good heading|.|Bad fragment|T:Good body', 'valid neighbors lost');
        assert(LLM.failureCount() === 1, 'entire group reported as failed');
        behavior = 'success';
    });
    await test('Per-book term deduplication, categories, chapters, and translation variants', () => {
        NamedTerms.reset();
        const entries = NamedTerms.validate([
            { category: '人名', source: 'Alice', target: '爱丽丝' },
            { category: '公司名', source: 'Acme', target: '艾克米' },
            { category: '产品名', source: 'Widget', target: '组件产品' },
            { category: '地名', source: 'Tokyo', target: '东京' },
            { category: '技术术语', source: 'API', target: '应用程序接口' },
            { category: '人名', source: 'Alice', target: '爱丽丝' },
            { category: '人名', source: 'Invented', target: '猜测' }
        ], 'Alice Acme Widget Tokyo API', '爱丽丝 艾克米 组件产品 东京 应用程序接口');
        assert(entries.length === 5, 'unanchored or duplicate terms accepted');
        NamedTerms.add({ file: 'A.epub', chapter: 'one.xhtml' }, entries, 'en', 'zh');
        NamedTerms.add({ file: 'A.epub', chapter: 'two.xhtml' }, entries, 'en', 'zh');
        NamedTerms.add({ file: 'B.epub', chapter: 'other.xhtml' }, [entries[0]], 'en', 'zh');
        NamedTerms.add({ file: 'A.epub', chapter: 'three.xhtml' }, [{ ...entries[0], target: '艾丽丝' }], 'en', 'zh');
        assert(NamedTerms.snapshot('A.epub').terms.length === 6 && NamedTerms.snapshot('B.epub').terms.length === 1, 'books or variants merged');
        assert(NamedTerms.snapshot('A.epub').terms[0].chapters.length === 2, 'chapter tracking');
        NamedTerms.flush();
        assert(NamedTerms.markdown(NamedTerms.snapshot('A.epub')).includes('| 人名 | Alice | 爱丽丝 |'), 'manual export');
        const select = document.getElementById('termsBook');
        assert(select.options.length === 2, 'book selector missing');
        select.value = 'B.epub'; select.dispatchEvent(new Event('change'));
        assert(document.getElementById('termsRows').children.length === 1, 'wrong book displayed');
    });
    await test('Cached term metadata rebuilds each book without another request', async () => {
        begin(); behavior = 'entities'; calls = 0;
        await LLM.translate(fixture, 'en', 'zh', 'kimi', context);
        assert(NamedTerms.snapshot(context.file).terms.some(term => term.source === 'world'), 'API terms not collected');
        NamedTerms.reset();
        await LLM.translate(fixture, 'en', 'zh', 'kimi', context);
        assert(calls === 1 && NamedTerms.snapshot(context.file).terms.some(term => term.source === 'world'), 'cached manual missing');
        behavior = 'success';
    });
    await test('Progress counts match source total with whitespace, punctuation, code and cache', async () => {
        begin(); behavior = 'success';
        const html = '<html><body><p>One two.\n三　四</p><p>27.</p><p>.</p><code>ignored</code><style>ignored{}</style></body></html>';
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const expected = LLM.countChars('One two.\n三　四27..');
        assert(LLM.countContent(doc) === expected, 'denominator includes excluded nodes or whitespace');
        const oldTotal = totalCharsToTranslate;
        totalCharsToTranslate = expected; totalSourceChars = 0;
        await LLM.translate(html, 'en', 'zh', 'kimi', context);
        assert(totalSourceChars === expected, 'fresh translation progress mismatch');
        totalSourceChars = 0;
        await LLM.translate(html, 'en', 'zh', 'kimi', context);
        assert(totalSourceChars === expected, 'cache progress mismatch');
        totalCharsToTranslate = oldTotal;
    });
    await test('ETA cannot go negative or mark cancelled/partial tasks complete', () => {
        const overflow = LLM.progressSnapshot(830032, 795261, 100, true, false, false);
        assert(overflow.processed === 795261 && overflow.state === 'finishing' && overflow.seconds === undefined, 'negative ETA');
        assert(LLM.progressSnapshot(50, 100, 10, true, false, false).seconds === 10, 'remaining estimate');
        assert(LLM.progressSnapshot(50, 100, 10, false, true, false).state === 'cancelled', 'cancelled shown complete');
        assert(LLM.progressSnapshot(50, 100, 10, false, false, true).state === 'partial', 'failure shown complete');
        assert(LLM.progressSnapshot(50, 100, 10, false, false, false).state === 'incomplete', 'unfinished shown complete');
    });
    await test('Group completion logs increase across concurrent chapters; retries count once', async () => {
        begin(); behavior = 'success'; capturedLogs.length = 0;
        await Promise.all(Array.from({ length: 5 }, (_, i) => LLM.translate(`<html><body><p>Chapter ${i}</p></body></html>`, 'en', 'zh', 'kimi', { file: 'groups.epub', chapter: `chapter${i}.xhtml` })));
        const counters = capturedLogs.filter(line => line.includes('groups.epub: 已处理')).map(line => Number(line.match(/已处理 (\d+)/)[1]));
        assert(counters.join(',') === '1,2,3,4,5', 'completion sequence not increasing');
        assert(LLM.groupProgress('groups.epub').total === 5 && LLM.groupProgress('groups.epub').succeeded === 5, 'group totals');
        begin(); behavior = 'onebad';
        await LLM.translate('<html><body><p>Good</p><p>Bad fragment</p></body></html>', 'en', 'zh', 'kimi', { file: 'retry.epub', chapter: 'chapter.xhtml' });
        const retry = LLM.groupProgress('retry.epub');
        assert(retry.total === 1 && retry.completed === 1 && retry.failed === 1, 'split retries inflated group count');
        behavior = 'success';
    });
    await test('Whole paragraphs retain inline links, emphasis, and code without duplicating nested blocks', () => {
        const doc = new DOMParser().parseFromString('<html><body><div><p>Hello <em>world</em> with <a href="#n">a link</a> and <code>x=1</code>.</p><p>Another paragraph.</p></div></body></html>', 'text/html');
        const units = BlockUnits.extract(doc);
        assert(units.length === 2 && units[0].parts.length === 1, 'sentence split at inline tags');
        assert(BlockUnits.plain(units[0].original) === 'Hello world with a link and .', 'code leaked into translation');
        units[0].restore(`译文 ${units[0].original}`);
        assert(doc.querySelector('em').textContent === 'world' && doc.querySelector('a').getAttribute('href') === '#n' && doc.querySelector('code').textContent === 'x=1', 'inline structure lost');
        assert(!BlockUnits.validateTokens(units[0].original, 'missing markers'), 'missing markers accepted');
        const chunks = BlockUnits.split('One complete sentence. Another complete sentence.', 25);
        assert(chunks.join('') === 'One complete sentence. Another complete sentence.' && chunks[0].endsWith('. '), 'sentence boundary lost');
    });
    await test('Empty page anchors are absent from model payload and restored with IDs and namespaces', async () => {
        begin(); behavior = 'success'; calls = 0;
        const html = '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><p>For Dario, research often <span id="page_20"/>was not concrete.</p><p>Another <em>important <span id="p21" epub:type="pagebreak" role="doc-pagebreak" aria-label="21"/>sentence</em> here.</p></body></html>';
        const output = await LLM.translate(html, 'en', 'zh', 'kimi', context);
        const doc = new DOMParser().parseFromString(output, 'application/xhtml+xml');
        assert(!doc.querySelector('parsererror') && LLM.failureCount() === 0 && calls === 1, 'page anchor caused failure');
        assert(history[0][0] === 'For Dario, research often was not concrete.', 'page marker sent to model');
        assert(doc.querySelectorAll('#page_20,#p21').length === 2 && doc.querySelector('#p21').getAttributeNS('http://www.idpf.org/2007/ops','type') === 'pagebreak', 'page navigation lost');
        assert(doc.querySelector('#p21').getAttribute('aria-label') === '21' && doc.querySelector('em').textContent.includes('important'), 'attributes or emphasis lost');
        assert(history[0][1].includes('[[EPUB_TAG_') && !output.includes('[[EPUB_TAG_'), 'real formatting bypassed or placeholders leaked');
    });
    await test('Page anchors preserve ordering without splitting emoji or words', () => {
        const doc = new DOMParser().parseFromString('<html><body><p>A<span id="page_1"></span><span id="page_2"></span>B<span id="page_3"></span></p></body></html>', 'text/html');
        const unit = BlockUnits.extract(doc)[0];
        const translation = '你好🙂 completeword';
        unit.check(translation); unit.restore(translation);
        assert(doc.querySelector('p').textContent === translation, 'anchor restoration changed text');
        assert([...doc.querySelectorAll('span')].map(el=>el.id).join(',') === 'page_1,page_2,page_3', 'page order changed');
        assert(![...doc.querySelector('p').childNodes].some(node=>node.nodeType===3 && /[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/.test(node.data)), 'split surrogate pair');
        const note = new DOMParser().parseFromString('<html><body><p>A<span id="note"></span>B<a id="page_4" href="#note">link</a></p></body></html>', 'text/html');
        assert(BlockUnits.extract(note)[0].original.includes('[[EPUB_TAG_'), 'footnote or link treated as neutral page anchor');
    });
    await test('Validated v4 page-marker caches migrate without paying to retranslate', async () => {
        begin(); behavior = 'success'; calls = 0;
        const html = '<html><body><p>Before <span id="page_20"></span>after.</p></body></html>';
        const record = BlockUnits.extract(new DOMParser().parseFromString(html,'text/html'))[0];
        const oldKey = `${context.file}\n${record.legacyOriginal}`;
        addToCache(oldKey, 'en', 'zh', '之前[[EPUB_TAG_0]]之后。');
        addToCache(`entity-v1:${oldKey}`, 'en', 'zh', '[]');
        const output = await LLM.translate(html, 'en', 'zh', 'kimi', context);
        const doc = new DOMParser().parseFromString(output,'text/html');
        assert(calls === 0 && doc.querySelector('p').textContent === '之前之后。' && doc.querySelector('#page_20'), 'legacy cache ignored or anchor dropped');
        assert(getFromCache(`${context.file}\n${record.original}`,'en','zh') === '之前之后。', 'normalized cache not committed');
    });
    await test('Concurrent repeated paragraphs share a request within a book', async () => {
        begin(); behavior = 'success'; calls = 0;
        const html = '<html><body><p>Repeated complete paragraph.</p></body></html>';
        const outputs = await Promise.all(['one.xhtml', 'two.xhtml'].map(chapter => LLM.translate(html, 'en', 'zh', 'kimi', { file: 'shared.epub', chapter })));
        assert(calls === 1 && outputs.every(output => output.includes('T:Repeated complete paragraph.')), 'duplicate API requests');
        assert(LLM.groupProgress('shared.epub').completed === 2, 'shared group progress lost');
    });
    await test('Memory cache miss restores IndexedDB translation and metadata without API', async () => {
        begin(); behavior = 'success'; calls = 0;
        const text = 'db-lookup.epub\nStored complete paragraph.';
        const key = source => JSON.stringify([LLM.cacheScope(), 'en', 'zh', source]);
        await persistCacheEntries([[key(text), '已保存的完整段落译文。'], [key(`entity-v1:${text}`), '[]']]);
        cache.clear();
        const output = await LLM.translate('<html><body><p>Stored complete paragraph.</p></body></html>', 'en', 'zh', 'kimi', { file: 'db-lookup.epub', chapter: 'chapter.xhtml' });
        assert(calls === 0 && output.includes('已保存的完整段落译文'), 'database cache ignored');
    });
    await test('Approved book terminology is included in subsequent translation requests', async () => {
        begin(); behavior = 'glossary';
        NamedTerms.add({ file: 'glossary.epub', chapter: 'first.xhtml' }, [{ category: '人名', source: 'Alice', target: '爱丽丝' }], 'en', 'zh');
        const output = await LLM.translate('<html><body><p>Alice continues working.</p></body></html>', 'en', 'zh', 'kimi', { file: 'glossary.epub', chapter: 'next.xhtml' });
        assert(payload.messages[0].content.includes('"source":"Alice","target":"爱丽丝"') && output.includes('爱丽丝'), 'book glossary not applied');
        behavior = 'success';
    });
    await test('An outdated cached name is retained with a review warning, not paid retranslation', async () => {
        begin(); behavior = 'glossary'; calls = 0;
        const text = 'terms-cache.epub\nAlice continues working.';
        addToCache(text, 'en', 'zh', '艾丽丝继续工作。');
        addToCache(`entity-v1:${text}`, 'en', 'zh', JSON.stringify([{ category: '人名', source: 'Alice', target: '艾丽丝' }]));
        NamedTerms.add({ file: 'terms-cache.epub', chapter: 'first.xhtml' }, [{ category: '人名', source: 'Alice', target: '爱丽丝' }], 'en', 'zh');
        const output = await LLM.translate('<html><body><p>Alice continues working.</p></body></html>', 'en', 'zh', 'kimi', { file: 'terms-cache.epub', chapter: 'next.xhtml' });
        assert(calls === 0 && output.includes('艾丽丝') && LLM.warningCount() === 1 && LLM.failureCount() === 0, 'cache warning lost');
        behavior = 'success';
    });
    await test('Term boundaries reject substring hits and retain real Unicode word boundaries', () => {
        for (const [text, term] of [['OpenAI', 'AI'], ['Google God', 'Go'], ['Anne', 'Ann'], ['éAnn', 'Ann'], ['AI_model', 'AI']]) assert(!NamedTerms.contains(text, term), `${term} matched ${text}`);
        assert(NamedTerms.contains('AI, Go and Ann.', 'AI') && NamedTerms.contains('AI, Go and Ann.', 'Go') && NamedTerms.contains('AI, Go and Ann.', 'Ann'), 'real term not matched');
        assert(NamedTerms.contains('这是人工智能技术', '人工智能'), 'Chinese term needs no Latin word boundary');
        assert(NamedTerms.contains('对OpenAI来说，GPT-3更强。', 'OpenAI') && NamedTerms.contains('对OpenAI来说，GPT-3更强。', 'GPT-3'), 'Latin name touching Chinese rejected');
        assert(NamedTerms.contains('日本のOpenAIモデル', 'OpenAI') && NamedTerms.contains('한국의OpenAI모델', 'OpenAI'), 'CJK script boundaries rejected');
        assert(NamedTerms.validate([{category:'技术术语',source:'AI',target:'AI'}], 'OpenAI', 'OpenAI').length === 0, 'substring entity accepted');
    });
    await test('Automatic terminology conflicts warn without rejecting pronouns or retrying', async () => {
        begin(); behavior = 'success'; calls = 0;
        NamedTerms.add(context, [{category:'技术术语',source:'AI',target:'人工智能'}, {category:'技术术语',source:'Go',target:'围棋'}, {category:'人名',source:'Ann',target:'安'}], 'en', 'zh');
        await LLM.translate('<html><body><p>OpenAI Google God Anne</p></body></html>', 'en', 'zh', 'kimi', context);
        assert(calls === 1 && LLM.warningCount() === 0 && LLM.failureCount() === 0, 'substring caused review or retry');
        begin(); behavior = 'glossary'; calls = 0;
        NamedTerms.add(context, [{category:'人名',source:'Alice',target:'艾丽丝'}], 'en', 'zh');
        const output = await LLM.translate('<html><body><p>Alice continues working.</p></body></html>', 'en', 'zh', 'kimi', context);
        assert(calls === 1 && output.includes('爱丽丝') && LLM.warningCount() === 1 && LLM.failureCount() === 0 && cache.size === 2, 'warning discarded valid translation');
        assert(LLM.warnings()[0].status === 'needs_review', 'review state missing');
        assert(document.getElementById('singleCompletionTitle').textContent.includes('待审校'), 'completion hid warnings');
        behavior = 'success';
    });
    await test('Ambiguous automatic names are not silently locked to the first arrival', () => {
        NamedTerms.reset();
        NamedTerms.add(context, [{category:'人名',source:'Alice',target:'爱丽丝'}, {category:'人名',source:'Alice',target:'艾丽丝'}], 'en', 'zh');
        assert(NamedTerms.glossaryFor(context.file, 'Alice works.').length === 0, 'first variant locked');
        assert(NamedTerms.snapshot(context.file).terms.length === 2, 'variants removed');
    });
    await test('Missing, duplicated and empty IDs retry only the bad item', async () => {
        for (const kind of ['onebad', 'duplicate', 'empty']) {
            begin(); behavior = kind; calls = 0;
            const output = await LLM.translate('<html><body><p>Good neighbor</p><p>Bad fragment</p></body></html>', 'en', 'zh', 'kimi', context);
            assert(calls === 3 && history.filter(items => items.includes('Good neighbor')).length === 1, `${kind} retried good neighbor`);
            assert(history.slice(1).every(items => items.length === 1 && items[0] === 'Bad fragment'), `${kind} not targeted`);
            assert(output.includes('T:Good neighbor') && output.includes('Bad fragment') && LLM.failureCount() === 1 && cache.size === 2, `${kind} unsafe cache`);
            assert(payload.messages[0].content.includes('上次格式校验错误') && payload.messages[0].content.includes('数组'), 'repair prompt missing');
        }
        behavior = 'success';
    });
    await test('Shared repair request and token budgets cap retries without losing good output', async () => {
        for (const field of ['apiRepairBudget', 'apiRepairTokens', 'apiRetryLimit']) {
            begin(); behavior = 'onebad'; calls = 0;
            document.getElementById(field).value = '0';
            const output = await LLM.translate('<html><body><p>Good budget</p><p>Bad fragment</p></body></html>', 'en', 'zh', 'kimi', context);
            assert(calls === 1 && output.includes('T:Good budget') && LLM.failureCount() === 1, `${field} budget ignored`);
        }
        begin(); behavior = 'onebad'; calls = 0;
        document.getElementById('apiRepairBudget').value = '1';
        await Promise.all(['a','b','c'].map(chapter => LLM.translate(`<html><body><p>Bad fragment ${chapter}</p></body></html>`, 'en', 'zh', 'kimi', {...context,chapter})));
        assert(calls === 4 && LLM.repairBudget(context.file).requests === 1, 'chapters have separate repair budgets');
        behavior = 'success';
    });
    await test('Tag failures retry only their own ID and retain original XHTML structure', async () => {
        begin(); behavior = 'badmarkers'; calls = 0;
        const output = await LLM.translate('<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Good tag neighbor</p><p>Bad fragment <em>word</em></p></body></html>', 'en', 'zh', 'kimi', context);
        const doc = new DOMParser().parseFromString(output, 'application/xhtml+xml');
        assert(!doc.querySelector('parsererror') && doc.querySelector('em').textContent === 'word', 'failed tags damaged original');
        assert(calls === 3 && history.filter(items => items.includes('Good tag neighbor')).length === 1 && cache.size === 2, 'good paragraph retried or bad cached');
        behavior = 'success';
    });
    await test('401, 402, 403 stop queued chapters and duplicate waiters, then a fresh run can start', async () => {
        for (const kind of ['auth', 'balance', 'permission']) {
            begin(); behavior = kind; calls = 0;
            const output = await Promise.all(Array.from({length:6}, (_, i) => LLM.translate(`<html><body><p>Stop ${i % 3}</p></body></html>`, 'en', 'zh', 'kimi', {...context,chapter:`stop-${i}`})));
            assert(calls <= 2 && running === 0 && LLM.stopped() && output.every(text => !text.includes('T:Stop')), `${kind} kept requesting or hung`);
            const stoppedCalls = calls;
            await LLM.translate('<html><body><p>Later chapter</p></body></html>', 'en', 'zh', 'kimi', context);
            assert(calls === stoppedCalls && document.getElementById('singleCompletionTitle').textContent.includes('停止'), 'fatal stop lost');
        }
        begin(); behavior = 'success'; calls = 0;
        await LLM.translate('<html><body><p>Fresh task</p></body></html>', 'en', 'zh', 'kimi', context);
        assert(calls === 1 && !LLM.stopped(), 'fatal leaked into fresh task');
    });
    await test('Whole-record restore failure never publishes cache, terms or successful progress', async () => {
        begin(); behavior = 'success'; totalSourceChars = 0;
        const extract = BlockUnits.extract;
        BlockUnits.extract = doc => {
            const records = extract(doc), record = records[0];
            record.parts = [{id:'p0-s0',text:'First sentence. '},{id:'p0-s1',text:'Second sentence.'}];
            record.check = () => { throw new Error('injected whole-record nesting failure'); };
            return records;
        };
        try {
            const output = await LLM.translate('<html><body><p>First sentence. Second sentence.</p></body></html>', 'en', 'zh', 'kimi', context);
            assert(!output.includes('T:') && cache.size === 0 && totalSourceChars === 0 && LLM.failureCount() === 1, 'restoration failure cached or counted');
            assert(LLM.groupProgress(context.file).failed === 1 && document.getElementById('singleCompletionTitle').textContent.includes('部分完成'), 'false completion');
        } finally { BlockUnits.extract = extract; }
    });
    await test('Cancel also releases coalesced duplicate paragraph requests', async () => {
        begin(); behavior = 'success';
        const html = '<html><body><p>Shared cancellation paragraph.</p></body></html>';
        const tasks = ['one', 'two'].map(chapter => LLM.translate(html, 'en', 'zh', 'kimi', { file: 'cancel-shared.epub', chapter }));
        setTimeout(() => { shouldCancel = true; document.getElementById('cancelBtn').click(); }, 5);
        const results = await Promise.allSettled(tasks);
        assert(results.every(result => result.status === 'rejected'), 'shared request left waiting');
        shouldCancel = false;
    });
    await test('Invalid key characters are rejected before fetch', () => {
        document.getElementById('taotokenBaseUrl').value = 'https://api.taotoken.net/v1';
        const input = document.getElementById('taotokenApiKey');
        const previousCalls = calls;
        for (const key of ['中文密钥', 'sk-abc\u200bdef', 'sk-abc def', 'ｓｋ-abc', 'Bearer test-key']) {
            input.value = key;
            let rejected = false;
            try { LLM.begin('taotoken', 'ja', 'zh'); } catch { rejected = true; }
            assert(rejected, 'invalid key accepted');
        }
        assert(calls === previousCalls, 'request sent with invalid key');
        input.value = 'taotoken-test-key';
    });
    await test('TaoToken requires explicit billing choice', () => {
        document.getElementById('taotokenBaseUrl').value = '';
        let rejected = false;
        try { LLM.begin('taotoken', 'en', 'zh'); } catch { rejected = true; }
        assert(rejected, 'billing default selected implicitly');
    });
    await test('Cancel aborts active requests and drains queued chapters', async () => {
        begin(); behavior = 'success';
        const tasks = Array.from({ length: 5 }, (_, index) => LLM.translate(`<html><body><p>Cancel ${index}</p></body></html>`, 'en', 'zh', 'kimi', context));
        setTimeout(() => { shouldCancel = true; document.getElementById('cancelBtn').click(); }, 5);
        const settled = await Promise.allSettled(tasks);
        assert(settled.every(item => item.status === 'rejected') && running === 0, 'cancel failed');
    });
    await test('Confirmed concepts and independent aliases persist per book and language', () => {
        const name = 'confirmed-preferences-test.epub';
        const key = `epub-confirmed-terms-v1:${JSON.stringify([name, 'en', 'zh'])}`;
        localStorage.removeItem(key);
        try {
            NamedTerms.prepare(name, 'en', 'zh');
            NamedTerms.confirm(name, 'Dario Amodei', '达里奥·阿莫代伊', [{source:'Amodei',target:'阿莫代伊'}], '人名');
            NamedTerms.confirm(name, 'Big Blob of Compute', '算力大团块');
            const frozen = NamedTerms.confirmedSnapshot(name);
            assert(frozen.entries.length === 3 && Object.isFrozen(frozen.entries), 'aliases not frozen');
            NamedTerms.reset();
            assert(NamedTerms.prepare(name, 'en', 'zh').entries.length === 3, 'preferences not restored');
            assert(NamedTerms.prepare(name, 'en', 'ja').entries.length === 0, 'language preferences leaked');
        } finally { localStorage.removeItem(key); NamedTerms.reset(); }
    });
    await test('Longest terms suppress overlapping short names but retain separate occurrences', () => {
        const terms = [{source:'AI',target:'人工智能'}, {source:'AI safety',target:'人工智能安全'}];
        assert(NamedTerms.selectTerms('AI safety at OpenAI', terms).length === 1, 'short term or substring leaked');
        assert(NamedTerms.selectTerms('AI safety and AI', terms).length === 2, 'standalone name suppressed');
        assert(NamedTerms.selectTerms('God and Google', [{source:'Go',target:'围棋'}]).length === 0, 'Go substring matched');
    });
    await test('Confirmed glossary is frozen during a task and isolates the next task cache', async () => {
        const name = 'confirmed-session-test.epub';
        const key = `epub-confirmed-terms-v1:${JSON.stringify([name, 'en', 'zh'])}`;
        localStorage.removeItem(key);
        try {
            NamedTerms.prepare(name, 'en', 'zh'); NamedTerms.confirm(name, 'compute', '算力');
            begin(); behavior = 'success'; calls = 0;
            const html = '<html><body><p>We need compute.</p></body></html>', ctx = {...context,file:name};
            await LLM.translate(html, 'en', 'zh', 'kimi', ctx);
            assert(payload.messages[0].content.includes('人工确认') && payload.messages[0].content.includes('算力'), 'confirmed prompt missing');
            NamedTerms.confirm(name, 'compute', '计算资源');
            await LLM.translate(html, 'en', 'zh', 'kimi', ctx);
            assert(calls === 1, 'mid-task glossary changed cache');
            LLM.begin('kimi', 'en', 'zh');
            await LLM.translate(html, 'en', 'zh', 'kimi', ctx);
            assert(calls === 2 && payload.messages[0].content.includes('计算资源'), 'next task used stale confirmed cache');
        } finally { localStorage.removeItem(key); NamedTerms.reset(); }
    });
    await test('Term panel batches rapid updates and renders at most 50 entries', () => {
        NamedTerms.reset();
        const before = NamedTerms.renderCount();
        for (let index = 0; index < 150; index++) NamedTerms.add({file:'panel-test.epub'}, [{category:'技术术语',source:`term${index}`,target:`译名${index}`}], 'en', 'zh');
        assert(NamedTerms.renderCount() === before, 'synchronous full-table rebuild');
        NamedTerms.flush();
        assert(NamedTerms.renderCount() === before + 1 && document.getElementById('termsRows').children.length === 50, 'pagination or throttling failed');
    });
    await test('Chapter cache reads are batched instead of awaiting each paragraph', async () => {
        begin(); behavior = 'success'; batchReads = 0;
        const html = `<html><body>${Array.from({length:150}, (_,i) => `<p>Batch paragraph ${i}.</p>`).join('')}</body></html>`;
        await LLM.translate(html, 'en', 'zh', 'kimi', {...context,file:'batch-read-test.epub'});
        assert(batchReads === 2, `expected two cache windows, got ${batchReads}`);
        const before = calls;
        await LLM.translate(html, 'en', 'zh', 'kimi', {...context,file:'batch-read-test.epub'});
        assert(calls === before, 'warm batch lookup lost cached translations');
    });
    await test('Rule review flags numbers, English, quotes and noise without rejecting translations', () => {
        const check = (original, translated) => TranslationQuality.check(original, translated, {targetLang:'zh',terms:[{source:'OpenAI',target:'OpenAI'}]});
        assert(!check('175 billion parameters', '1750亿个参数').some(flag => flag.code === 'numbers'), 'equivalent scales rejected');
        const flags = check('OpenAI had 175 billion parameters, not 100.', 'OpenAI有1700亿个参数和100个，"sprawling"，许<多。');
        for (const code of ['numbers','english','quotes','negation','noise']) assert(flags.some(flag => flag.code === code), `${code} check missing`);
        assert(!check('OpenAI works.', 'OpenAI工作。').some(flag => flag.code === 'english'), 'registered name flagged');
        assert(check('This paragraph is still completely in English.', 'This paragraph is still completely in English.').some(flag => flag.code === 'untranslated'), 'unchanged original missed');
    });
    await test('Quality warnings retain validated output and cache; warm reuse runs checks too', async () => {
        begin(); behavior = 'success'; calls = 0;
        const html = '<html><body><p>A sprawling research division.</p></body></html>', ctx = {...context,file:'quality-test.epub'};
        const output = await LLM.translate(html, 'en', 'zh', 'kimi', ctx);
        assert(output.includes('T:') && LLM.failureCount() === 0 && cache.size === 2, 'review candidate rejected or not cached');
        assert(LLM.warnings().some(item => item.code === 'english' && item.original && item.translated), 'review evidence missing');
        LLM.begin('kimi', 'en', 'zh');
        await LLM.translate(html, 'en', 'zh', 'kimi', ctx);
        assert(calls === 1 && LLM.warnings().some(item => item.code === 'english'), 'warm-cache quality check missing');
    });
    await test('IndexedDB batch lookup returns all hits and ignores duplicate or missing keys', async () => {
        await persistCacheEntries([['quality-batch-test-a','甲'],['quality-batch-test-b','乙']]);
        const found = await Persistence.getCacheEntries(['quality-batch-test-a','quality-batch-test-a','quality-batch-test-b','quality-batch-missing']);
        assert(found.size === 2 && found.get('quality-batch-test-b') === '乙', 'batch values missing');
        assert((await Persistence.getCacheEntries([])).size === 0, 'empty batch failed');
    });
    await test('Human review acknowledgment is reversible and never sends another request', () => {
        const before = calls;
        document.getElementById('translationFailureList').querySelector('button').click();
        assert(LLM.warnings()[0].status === 'reviewed' && document.getElementById('translationReportSummary').textContent.includes('0 条警告待审校'), 'review state not updated');
        document.getElementById('translationFailureList').querySelector('button').click();
        assert(LLM.warnings()[0].status === 'needs_review' && calls === before, 'review acknowledgment requested API or not reversible');
    });
    await test('Removing confirmation persists and glossary snapshots respect translation direction', () => {
        const name = 'confirmed-direction-test.epub', key = `epub-confirmed-terms-v1:${JSON.stringify([name,'en','zh'])}`;
        localStorage.removeItem(key);
        try {
            NamedTerms.prepare(name, 'en', 'zh'); NamedTerms.confirm(name, 'compute', '算力');
            assert(NamedTerms.freezeAll('en','ja').size === 0, 'wrong-language confirmed glossary frozen');
            NamedTerms.unconfirm(name, 'compute'); NamedTerms.reset();
            assert(NamedTerms.prepare(name,'en','zh').entries.length === 0, 'removed confirmation restored');
        } finally { localStorage.removeItem(key); NamedTerms.reset(); }
    });
    function orderedFixture(container = true) {
        const data = {
            'OPS/second.xhtml':'<html><body><p>Second chapter.</p></body></html>',
            'OPS/nav.xhtml':'<html><body><p>Navigation.</p></body></html>',
            'OPS/first.xhtml':'<html><body><p>First chapter.</p></body></html>',
            'OPS/extra.htm':'<html><body><p>Supplement.</p></body></html>',
            'META-INF/container.xml':'<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
            'OPS/package.opf':'<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="a" href="first.xhtml"/><item id="b" href="second.xhtml"/><item id="n" href="nav.xhtml"/><item id="x" href="extra.htm"/></manifest><spine><itemref idref="a"/><itemref idref="b"/><itemref idref="x" linear="no"/><itemref idref="a"/></spine></package>'
        };
        if (!container) delete data['META-INF/container.xml'];
        return {files:Object.fromEntries(Object.entries(data).map(([name,text])=>[name,{async:async()=>text}]))};
    }
    await test('Spine order overrides ZIP order, deduplicates entries and defers supplementary navigation', async () => {
        const zip = orderedFixture(), files = Object.keys(zip.files).filter(EpubOrder.isContent);
        const plan = await EpubOrder.order(zip,files);
        assert(plan.spine && plan.files.join('|') === 'OPS/first.xhtml|OPS/second.xhtml|OPS/extra.htm|OPS/nav.xhtml', 'wrong reading order');
        assert(EpubOrder.resolve('OPS/package.opf','chapters/../text%20one.xhtml#p') === 'OPS/text one.xhtml', 'relative encoded href failed');
        assert(EpubOrder.resolve('OPS/package.opf','https://evil.example/page.xhtml') === null, 'external href accepted');
    });
    await test('Missing spine safely falls back; chapter loading is bounded and cancellation preserves originals', async () => {
        const zip=orderedFixture(false), files=Object.keys(zip.files).filter(EpubOrder.isContent);
        const plan=await EpubOrder.order(zip,files); assert(!plan.spine && plan.warning && plan.files.join('|')===files.join('|'), 'fallback lost content');
        let active=0,max=0,stop=false,started=[];
        const output=await EpubOrder.run(zip,files,async(filename,content)=>{
            active++; max=Math.max(max,active); started.push(filename);
            await new Promise(resolve=>setTimeout(resolve,5)); active--; stop=true; return 'translated';
        },{shouldStop:()=>stop});
        assert(max===1 && started.length===1 && output.length===files.length && output[1].translatedText.includes('Navigation'), 'cancel starts future chapters or drops originals');
    });
    await test('Ordered chapters use validated previous translations without book or task leakage', async () => {
        begin(); behavior='success';
        const name='context-book.epub';
        await EpubOrder.run(orderedFixture(),['OPS/second.xhtml','OPS/first.xhtml'],async(chapter,html,readingOrder)=>LLM.translate(html,'en','zh','kimi',{file:name,chapter,readingOrder}));
        const reference=JSON.parse(requests[1].messages[0].content.split('context_reference_only:')[1]);
        assert(reference[0].original==='First chapter.' && reference[0].translated==='T:First chapter.', 'validated chapter tail missing');
        assert(JSON.parse(requests[1].messages[1].content).length===1, 'reference included as a translation ID');
        await LLM.translate('<html><body><p>Different book.</p></body></html>','en','zh','kimi',{file:'different-context.epub',readingOrder:1});
        assert(JSON.parse(requests.at(-1).messages[0].content.split('context_reference_only:')[1]).length===0, 'cross-book context leak');
        begin(); await LLM.translate('<html><body><p>Fresh chapter.</p></body></html>','en','zh','kimi',{file:name,readingOrder:1});
        assert(JSON.parse(payload.messages[0].content.split('context_reference_only:')[1]).length===0, 'previous task context leak');
    });
    await test('Concurrent groups receive prior source without waiting for prior translated output', async () => {
        begin(); behavior='success'; calls=0;
        const paragraphs=Array.from({length:7},(_,i)=>`Paragraph ${i}. `+'word '.repeat(145));
        await LLM.translate(`<html><body>${paragraphs.map(p=>`<p>${p}</p>`).join('')}</body></html>`,'en','zh','kimi',{file:'group-context.epub'});
        const reference=JSON.parse(requests[1].messages[0].content.split('context_reference_only:')[1]);
        assert(reference.length===2 && reference.every(entry=>entry.original && entry.translated===undefined), 'unvalidated or missing source context');
        assert(reference.reduce((sum,entry)=>sum+entry.original.length,0)<=1200, 'unbounded context');
    });
    await test('Terms-only responses need no text and never rewrite cached XHTML', async () => {
        begin(); behavior='entities'; calls=0;
        const ctx={file:'only-terms.epub'}, text='Hello world.';
        addToCache(`${ctx.file}\n${text}`,'en','zh','你好world。');
        const output=await LLM.translate(`<html><body><p>${text}</p></body></html>`,'en','zh','kimi',ctx);
        assert(calls===1 && output.includes('你好world。') && !output.includes('T:'), 'cached translation rewritten');
        assert(payload.messages[0].content.includes('不输出text字段') && payload.max_tokens<8000, 'not a bounded metadata request');
        assert(NamedTerms.snapshot(ctx.file).terms.some(term=>term.source==='world'), 'terms-only result not collected');
        await LLM.translate(`<html><body><p>${text}</p></body></html>`,'en','zh','kimi',ctx);
        assert(calls===1, 'metadata not cached');
    });
    await test('Mixed misses and metadata hits use separate request schemas', async () => {
        begin(); behavior='success'; calls=0;
        const ctx={file:'mixed-terms.epub'}; addToCache(`${ctx.file}\nCached paragraph.`,'en','zh','已有译文。');
        await LLM.translate('<html><body><p>Cached paragraph.</p><p>New paragraph.</p></body></html>','en','zh','kimi',ctx);
        assert(calls===2 && requests.every(request=>{
            const items=JSON.parse(request.messages[1].content); return items.every(item=>('translated' in item)===('translated' in items[0]));
        }), 'mixed terms-only and translation schema');
    });
    await test('Failed metadata extraction retains translation and does not cache false empty metadata', async () => {
        begin(); behavior='metadata-invalid'; calls=0;
        const ctx={file:'bad-metadata.epub'}, text='Cached original paragraph.';
        addToCache(`${ctx.file}\n${text}`,'en','zh','已验证的缓存译文。');
        const output=await LLM.translate(`<html><body><p>${text}</p></body></html>`,'en','zh','kimi',ctx);
        assert(output.includes('已验证的缓存译文。') && calls===3 && LLM.failureCount()===0, 'metadata failure discarded translation');
        assert(getFromCache(`entity-v1:${ctx.file}\n${text}`,'en','zh')===undefined && LLM.warnings().some(w=>w.code==='term_metadata'), 'failed metadata published as valid');
        behavior='success';
    });
    await test('Failed previous paragraphs provide source only, never unvalidated translated references', async () => {
        begin(); behavior='onebad';
        const ctx={file:'failed-context.epub',readingOrder:0};
        await LLM.translate('<html><body><p>Bad fragment.</p></body></html>','en','zh','kimi',ctx);
        behavior='success';
        await LLM.translate('<html><body><p>Next chapter.</p></body></html>','en','zh','kimi',{...ctx,readingOrder:1});
        const reference=JSON.parse(payload.messages[0].content.split('context_reference_only:')[1]);
        assert(reference[0].original==='Bad fragment.' && !('translated' in reference[0]), 'failed output trusted as context');
    });
    await test('Terms-only validation ignores attempted text rewrites and rejects missing terms arrays', () => {
        const items=[{id:'a',text:'Original.',cachedTranslated:'已验证译文。'}];
        const mapped=LLM.validateResult('[{"id":"a","text":"unauthorized rewrite","terms":[]}]',items);
        assert(mapped.get('a')==='已验证译文。', 'metadata overwrote cached text');
        let rejected=false; try { LLM.validateResult('[{"id":"a"}]',items); } catch { rejected=true; }
        assert(rejected, 'missing metadata accepted');
    });
    await test('Metadata ID repairs retry only missing entries, retaining valid neighbor metadata', async () => {
        begin(); behavior='metadata-onemissing'; calls=0;
        const ctx={file:'metadata-repair.epub'};
        addToCache(`${ctx.file}\nGood metadata.`,'en','zh','正确的已有译文。');
        addToCache(`${ctx.file}\nBad metadata.`,'en','zh','另一个已有译文。');
        const output=await LLM.translate('<html><body><p>Good metadata.</p><p>Bad metadata.</p></body></html>','en','zh','kimi',ctx);
        assert(history.filter(items=>items.includes('Good metadata.')).length===1 && calls===3 && output.includes('另一个已有译文。'), 'metadata retried good neighbors or lost output');
        assert(getFromCache(`entity-v1:${ctx.file}\nGood metadata.`,'en','zh')==='[]' && getFromCache(`entity-v1:${ctx.file}\nBad metadata.`,'en','zh')===undefined, 'bad metadata cached or good metadata dropped');
        behavior='success';
    });
    await test('Fatal API failure stops ordered future chapters and preserves their originals', async () => {
        begin(); behavior='auth'; calls=0;
        const zip=orderedFixture();
        const output=await EpubOrder.run(zip,['OPS/second.xhtml','OPS/first.xhtml'],async(chapter,html,readingOrder)=>LLM.translate(html,'en','zh','kimi',{file:'fatal-order.epub',chapter,readingOrder}),{shouldStop:()=>LLM.stopped()});
        assert(calls===1 && output[1].filename==='OPS/second.xhtml' && output[1].translatedText.includes('Second chapter.'), 'fatal launched next chapter or lost its original');
        behavior='success'; begin();
    });
    await test('Same-named books keep separate reading-session contexts', async () => {
        begin(); behavior='success';
        const ctx={file:'same-name.epub',readingOrder:0,readingSession:'book-one'};
        await LLM.translate('<html><body><p>Private first book.</p></body></html>','en','zh','kimi',ctx);
        await LLM.translate('<html><body><p>Second book next chapter.</p></body></html>','en','zh','kimi',{...ctx,readingOrder:1,readingSession:'book-two'});
        assert(JSON.parse(payload.messages[0].content.split('context_reference_only:')[1]).length===0, 'same-name book leaked its tail');
    });
    const withTermBook = async (suffix, action) => {
        const name=`import-test-${suffix}.epub`, key=`epub-confirmed-terms-v1:${JSON.stringify([name,'en','zh'])}`;
        localStorage.removeItem(key); NamedTerms.reset(); NamedTerms.prepare(name,'en','zh');
        try { await action(name); } finally { localStorage.removeItem(key); NamedTerms.reset(); }
    };
    await test('JSON import accepts exported manuals and simple arrays without promoting candidates', () => withTermBook('formats', name => {
        const parsed=NamedTerms.parseImport(JSON.stringify({name:'another-name.epub',sourceLang:'en',targetLang:'zh',terms:[{source:'Alice',target:'爱丽丝',category:'人名'}],confirmed:[{source:'Alice',target:'爱丽丝',category:'人名',aliases:[{source:'Al',target:'小爱'}]}]}),name);
        const result=NamedTerms.importTerms(name,parsed);
        assert(result.added===1 && NamedTerms.confirmedSnapshot(name).entries.length===0, 'candidate promoted or not imported');
        assert(NamedTerms.snapshot(name).terms.some(term=>term.source==='Al'), 'exported aliases lost');
        NamedTerms.importTerms(name,NamedTerms.parseImport('[{"source":"compute","target":"算力"}]',name));
        assert(NamedTerms.snapshot(name).terms.some(term=>term.source==='compute' && term.category==='技术术语'), 'simple format rejected');
    }));
    await test('Duplicate imports are idempotent and candidates survive a new run and reload', () => withTermBook('persist', name => {
        const parsed=NamedTerms.parseImport('[{"source":"compute","target":"算力"}]',name);
        NamedTerms.importTerms(name,parsed); const repeat=NamedTerms.importTerms(name,parsed);
        assert(repeat.added===0 && repeat.skipped===1, 'duplicate rows created');
        NamedTerms.startRun(); assert(NamedTerms.snapshot(name).terms.length===1, 'run discarded manual candidates');
        NamedTerms.reset(); NamedTerms.prepare(name,'en','zh');
        assert(NamedTerms.snapshot(name).terms[0].target==='算力', 'manual candidates not persisted');
    }));
    await test('Import preserves existing confirmations and retains alternate targets as conflicts', () => withTermBook('conflict', name => {
        NamedTerms.confirm(name,'compute','算力');
        const parsed=NamedTerms.parseImport('{"terms":[{"source":"compute","target":"计算资源","status":"已确认"}]}',name);
        const result=NamedTerms.importTerms(name,parsed,true);
        assert(result.conflicts===1 && NamedTerms.confirmedSnapshot(name).entries[0].target==='算力', 'existing confirmation overwritten');
        assert(NamedTerms.snapshot(name).terms.some(term=>term.target==='计算资源' && term.status==='冲突'), 'variant lost');
    }));
    await test('Opt-in confirmed import retains alias-specific targets and exported round trips', () => withTermBook('roundtrip', name => {
        const parsed=NamedTerms.parseImport('{"terms":[{"source":"Dario Amodei","target":"达里奥·阿莫代伊","status":"已确认","aliases":[{"source":"Amodei","target":"阿莫代伊"}]}]}',name);
        NamedTerms.importTerms(name,parsed,true);
        const exported=JSON.stringify(NamedTerms.snapshot(name)); NamedTerms.reset(); NamedTerms.prepare(name,'en','zh');
        NamedTerms.importTerms(name,NamedTerms.parseImport(exported,name),true);
        assert(NamedTerms.confirmedSnapshot(name).entries.some(term=>term.source==='Amodei' && term.target==='阿莫代伊'), 'roundtrip alias lost');
    }));
    await test('Bad import data is rejected atomically and translation direction is checked', () => withTermBook('invalid', name => {
        const invalid=['{','{}','{"terms":[{"source":"A","target":"甲"},{"source":"B","target":""}]}','{"sourceLang":"ja","terms":[]}','{"terms":[{"source":"A","target":"甲","category":"unknown"}]}','{"terms":[{"source":"A","target":"甲","aliases":[{"source":"A","target":"乙"}]}]}'];
        for(const input of invalid) { let rejected=false;try{NamedTerms.importTerms(name,NamedTerms.parseImport(input,name));}catch{rejected=true;}assert(rejected && NamedTerms.snapshot(name).terms.length===0,'invalid import partially committed'); }
        const parsed=NamedTerms.parseImport('[{"source":"A","target":"甲"}]',name);
        NamedTerms.prepare(name,'ja','zh'); let rejected=false;try{NamedTerms.importTerms(name,parsed);}catch{rejected=true;}assert(rejected,'stale direction accepted');
    }));
    await test('Editing changes source, category, aliases and approval without dropping chapter references', () => withTermBook('edit', name => {
        NamedTerms.add({file:name,chapter:'one.xhtml'},[{category:'人名',source:'Alicee',target:'旧译名'}],'en','zh');
        const before=NamedTerms.snapshot(name).terms[0];
        NamedTerms.saveTerm(name,before,{category:'产品名',source:'Alice',target:'新译名',aliases:[{source:'Al',target:'简称'}]},true);
        const entry=NamedTerms.snapshot(name).terms.find(term=>term.source==='Alice');
        assert(entry.category==='产品名' && entry.target==='新译名' && entry.chapters.includes('one.xhtml') && entry.status==='已确认', 'edit fields lost');
        assert(!NamedTerms.snapshot(name).terms.some(term=>term.source==='Alicee'), 'old entry retained');
        NamedTerms.saveTerm(name,entry,{category:'技术术语',source:'Alice',target:'候选译名',aliases:[]},false);
        assert(NamedTerms.confirmedSnapshot(name).entries.length===0 && NamedTerms.snapshot(name).terms[0].status==='候选', 'approval not cleared');
    }));
    await test('Editing rejects alias ownership collisions without losing prior confirmation', () => withTermBook('alias', name => {
        NamedTerms.confirm(name,'Alice','爱丽丝',[{source:'Al',target:'小爱'}],'人名'); NamedTerms.confirm(name,'Bob','鲍勃',[],'人名');
        let rejected=false;try{NamedTerms.saveTerm(name,{source:'Bob',target:'鲍勃'},{source:'Robert',target:'罗伯特',aliases:[{source:'Al',target:'其他人'}]},true);}catch{rejected=true;}
        assert(rejected && NamedTerms.confirmedSnapshot(name).entries.some(term=>term.source==='Bob'), 'invalid edit damaged previous standard');
    }));
    await test('Storage failure rolls back imported and edited terminology', () => withTermBook('quota', name => {
        NamedTerms.confirm(name,'compute','算力'); const version=NamedTerms.snapshot(name).version;
        const setItem=Storage.prototype.setItem;
        try {
            Storage.prototype.setItem=function(key,value){if(key.startsWith('epub-confirmed-terms-v1:'))throw new Error('quota');return setItem.call(this,key,value);};
            for(const change of [()=>NamedTerms.importTerms(name,NamedTerms.parseImport('[{"source":"Alice","target":"爱丽丝"}]',name)),()=>NamedTerms.saveTerm(name,{source:'compute',target:'算力'},{source:'compute',target:'计算资源'},true)]) {
                let rejected=false;try{change();}catch{rejected=true;}
                assert(rejected && NamedTerms.snapshot(name).version===version && NamedTerms.snapshot(name).terms.length===1 && NamedTerms.confirmedSnapshot(name).entries[0].target==='算力','failed storage changed in-memory book');
            }
        } finally { Storage.prototype.setItem=setItem; }
    }));
    await test('Imported markup is rendered as literal text, never executable HTML', () => withTermBook('markup', name => {
        const source='<img src=x onerror=alert(1)>';
        NamedTerms.importTerms(name,NamedTerms.parseImport(JSON.stringify([{source,target:'字面量'}]),name)); NamedTerms.flush();
        assert(!document.getElementById('termsRows').querySelector('img') && document.getElementById('termsRows').textContent.includes(source),'untrusted import rendered as HTML');
    }));
    const failed = results.filter(line => line.startsWith('FAIL')).length;
    document.getElementById('results').textContent += `\n${results.length - failed}/${results.length} passed`;
});
