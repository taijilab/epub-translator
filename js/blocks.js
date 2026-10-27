(() => {
    const blockSelector = 'p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,dt,dd,div,section,article';
    const ignored = 'script,style,pre,code';
    const tokenPattern = /\[\[EPUB_TAG_\d+\]\]/g;
    const plain = text => String(text ?? '').replace(tokenPattern, '');
    function isPageAnchor(element) {
        if (!['span', 'a'].includes(element.localName) || element.hasAttribute('href') || element.childNodes.length) return false;
        const type = element.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || element.getAttribute('epub:type') || '';
        return type.split(/\s+/).includes('pagebreak') || element.getAttribute('role') === 'doc-pagebreak' || /^(?:page|pg)[_-]?\d+$/i.test(element.id);
    }
    function restorePageAnchors(doc, fragment, anchors, sourceLength) {
        if (!anchors.length) return;
        const nodes = () => {
            const walker = doc.createTreeWalker(fragment, NodeFilter.SHOW_TEXT), result = [];
            let node;
            while ((node = walker.nextNode())) if (!node.parentElement?.closest(ignored)) result.push(node);
            return result;
        };
        const text = nodes().map(node => node.data).join('');
        const boundaries = typeof Intl.Segmenter === 'function'
            ? [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)].map(part => part.index).concat(text.length)
            : [...text].reduce((edges, character) => { edges.push(edges.at(-1) + character.length); return edges; }, [0]);
        // Reflowed translations have no exact source-page offsets; retain ordered jump targets near their relative position.
        for (const anchor of [...anchors].reverse()) {
            const estimate = sourceLength ? Math.round(anchor.offset / sourceLength * text.length) : 0;
            let position = boundaries.reduce((best, edge) => Math.abs(edge - estimate) < Math.abs(best - estimate) ? edge : best, 0);
            const clone = anchor.element.cloneNode(true);
            let inserted = false;
            for (const node of nodes()) {
                if (position <= node.length) {
                    const tail = node.splitText(position);
                    tail.parentNode.insertBefore(clone, tail); inserted = true; break;
                }
                position -= node.length;
            }
            if (!inserted) fragment.appendChild(clone);
        }
    }
    function split(text, limit = 2000) {
        const sentences = typeof Intl.Segmenter === 'function'
            ? [...new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(text)].map(item => item.segment)
            : text.match(/[^.!?。！？]+[.!?。！？]*\s*|[.!?。！？]+\s*/g) || [text];
        const chunks = []; let current = '';
        for (const sentence of sentences) {
            if (current && current.length + sentence.length > limit) { chunks.push(current); current = ''; }
            current += sentence;
        }
        if (current) chunks.push(current);
        return chunks;
    }
    function validateTokens(original, translated) {
        const expected = original.match(tokenPattern) || [], actual = translated.match(tokenPattern) || [];
        return expected.length === actual.length && expected.every(token => actual.filter(value => value === token).length === 1);
    }
    function extract(doc) {
        const root = doc.getElementsByTagName('body')[0] || doc.documentElement;
        const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const owners = new Map(); let node;
        while ((node = walker.nextNode())) {
            if (!node.textContent.trim() || node.parentElement?.closest(ignored)) continue;
            const owner = node.parentElement?.closest(blockSelector) || root;
            if (!owners.has(owner)) owners.set(owner, []);
            owners.get(owner).push(node);
        }
        const records = [];
        for (const [owner, nodes] of owners) {
            if (owner.querySelector(blockSelector)) {
                nodes.forEach(node => records.push({ node, original: node.textContent, countText: node.textContent, restore: text => { node.textContent = text; } }));
                continue;
            }
            if (owner.textContent.includes('[[EPUB_TAG_')) {
                nodes.forEach(node => records.push({ node, original: node.textContent, countText: node.textContent, restore: text => { node.textContent = text; } }));
                continue;
            }
            const tokens = new Map(), pageAnchors = [], pageTokens = new Set(); let next = 0, countText = '';
            const mark = (kind, element) => { const key = `[[EPUB_TAG_${next++}]]`; tokens.set(key, { kind, element }); return key; };
            function serialize(element) {
                if (element.nodeType === Node.TEXT_NODE) { countText += element.textContent; return element.textContent; }
                if (element.nodeType !== Node.ELEMENT_NODE) return mark('atomic', element);
                if (isPageAnchor(element)) {
                    const token = mark('page', element);
                    pageTokens.add(token); pageAnchors.push({ offset: countText.length, element });
                    return token;
                }
                if (element.matches(ignored) || !element.childNodes.length) return mark('atomic', element);
                return mark('open', element) + [...element.childNodes].map(serialize).join('') + mark('close', element);
            }
            const legacyOriginal = [...owner.childNodes].map(serialize).join('');
            const normalizeCache = text => String(text).replace(tokenPattern, token => pageTokens.has(token) ? '' : token);
            const original = normalizeCache(legacyOriginal);
            function fragmentFor(text) {
                if (!validateTokens(original, text)) throw new Error('内联标签占位符缺失或重复');
                const fragment = doc.createDocumentFragment(), stack = [fragment], open = [];
                for (const part of text.split(/(\[\[EPUB_TAG_\d+\]\])/)) {
                    const token = tokens.get(part);
                    if (!token) { if (part) stack.at(-1).appendChild(doc.createTextNode(part)); continue; }
                    if (token.kind === 'close') {
                        if (open.pop() !== token.element) throw new Error('内联标签嵌套次序错误');
                        stack.pop();
                    } else if (token.kind === 'open') {
                        const clone = token.element.cloneNode(false); stack.at(-1).appendChild(clone); stack.push(clone); open.push(token.element);
                    } else stack.at(-1).appendChild(token.element.cloneNode(true));
                }
                if (stack.length !== 1) throw new Error('内联标签未闭合');
                restorePageAnchors(doc, fragment, pageAnchors, countText.length);
                return fragment;
            }
            records.push({ original, countText, legacyOriginal, normalizeCache, check: text => fragmentFor(text), restore: text => owner.replaceChildren(fragmentFor(text)) });
        }
        return records.map((record, index) => {
            const parts = split(record.original).map((text, part) => ({ id: `p${index}-s${part}`, text }));
            if (parts.length === 1 && record.legacyOriginal !== undefined && record.legacyOriginal !== record.original && split(record.legacyOriginal).length === 1) {
                parts[0].legacyText = record.legacyOriginal;
                parts[0].normalizeCache = record.normalizeCache;
            }
            return { ...record, parts };
        });
    }
    window.BlockUnits = { extract, split, plain, validateTokens };
})();
