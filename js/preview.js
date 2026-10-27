(() => {
    function documentFor(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        doc.querySelectorAll('script, iframe, object, embed, base, link, meta[http-equiv]').forEach(node => node.remove());
        for (const element of doc.querySelectorAll('*')) {
            for (const attribute of [...element.attributes]) {
                if (/^on/i.test(attribute.name) || /^(?:javascript|vbscript):/i.test(attribute.value.trim())) element.removeAttribute(attribute.name);
            }
        }
        const style = doc.createElement('style');
        style.textContent = `html, body { margin:0 !important; width:auto !important; height:auto !important; min-height:0 !important; overflow:auto !important; writing-mode:horizontal-tb !important; color:#111827 !important; background:#fff !important; }
body { padding:24px !important; font:16px/1.8 system-ui,sans-serif; }
img, svg { max-width:100%; height:auto; }`;
        doc.head.appendChild(style);
        if (!doc.body.textContent.trim() && !doc.body.querySelector('img, svg')) {
            const empty = doc.createElement('p'); empty.textContent = '本页没有可预览的文字。'; doc.body.appendChild(empty);
        }
        return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
    }
    function firstTextPage(pages) {
        const lengths = pages.map(page => {
            const doc = new DOMParser().parseFromString(page.content, 'text/html');
            doc.querySelectorAll('script, style').forEach(node => node.remove());
            return doc.body.textContent.trim().length;
        });
        const index = lengths.findIndex(length => length >= 40);
        return index >= 0 ? index : Math.max(0, lengths.findIndex(length => length > 0));
    }
    window.PreviewHelper = { documentFor, firstTextPage };
})();
