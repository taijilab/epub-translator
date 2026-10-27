/* Spine ordering and bounded chapter loading, shared by single and batch jobs. */
(() => {
    const isContent = path => /\.(?:html?|xhtml)$/i.test(path);
    let sequence = 0;
    const elements = (doc, name) => [...doc.getElementsByTagNameNS('*', name)];
    function parse(text) {
        const doc = new DOMParser().parseFromString(text, 'application/xml');
        if (doc.querySelector('parsererror')) throw new Error('EPUB 阅读顺序 XML 无效');
        return doc;
    }
    function resolve(base, href) {
        if (!href || /^[a-z][a-z\d+.-]*:|^\/\//i.test(href)) return null;
        const url = new URL(href, `https://epub.invalid/${base}`);
        if (url.origin !== 'https://epub.invalid') return null;
        return decodeURIComponent(url.pathname.slice(1));
    }
    async function order(zip, files) {
        try {
            const container = parse(await zip.files['META-INF/container.xml'].async('string'));
            const rootfiles = elements(container, 'rootfile');
            const packagePath = (rootfiles.find(el => el.getAttribute('media-type') === 'application/oebps-package+xml') || rootfiles[0])?.getAttribute('full-path');
            const packageDoc = parse(await zip.files[packagePath].async('string'));
            const items = new Map(elements(packageDoc, 'item').map(el => [el.getAttribute('id'), resolve(packagePath, el.getAttribute('href'))]));
            const available = new Set(files), seen = new Set(), primary = [], supplementary = [];
            for (const ref of elements(packageDoc, 'itemref')) {
                const path = items.get(ref.getAttribute('idref'));
                if (!available.has(path) || seen.has(path)) continue;
                seen.add(path);
                (ref.getAttribute('linear') === 'no' ? supplementary : primary).push(path);
            }
            if (!primary.length && !supplementary.length) throw new Error('spine 没有可处理的章节');
            return { files: [...primary, ...supplementary, ...files.filter(path => !seen.has(path))], spine: true };
        } catch (error) {
            return { files: [...files], spine: false, warning: `无法读取 spine，保留文件顺序：${error.message}` };
        }
    }
    async function run(zip, files, worker, options = {}) {
        const readingSession = `reading-${++sequence}`;
        const plan = await order(zip, files);
        options.onOrder?.(plan);
        const results = [];
        for (const [index, filename] of plan.files.entries()) {
            const content = await zip.files[filename].async('string');
            // A stopped job still copies untouched chapters into its partial EPUB.
            const translatedText = options.shouldStop?.() ? content : await worker(filename, content, index, readingSession);
            results.push({ filename, translatedText });
        }
        return results;
    }
    window.EpubOrder = { isContent, resolve, order, run };
})();
