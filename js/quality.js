/* Cheap review candidates, not a proof of semantic correctness. */
(() => {
    const latin = /[A-Za-z][A-Za-z'-]+/g;
    const allowed = new Set(['bug', 'ISBN', 'CEO', 'GPU', 'GPUs', 'GPT', 'AI', 'RLHF', 'RNN', 'RNNs', 'DNA', 'NDSEG', 'EKG']);
    const plain = text => window.BlockUnits?.plain(text) || String(text || '');
    function numbers(text) {
        const multipliers = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12, 万: 1e4, 亿: 1e8, 万亿: 1e12, 千亿: 1e11 };
        return [...text.matchAll(/\d+(?:,\d{3})*(?:\.\d+)?(?:\s*(thousand|million|billion|trillion|万亿|千亿|万|亿))?/gi)]
            .map(match => Number(match[0].match(/[\d.,]+/)[0].replaceAll(',', '')) * (multipliers[match[1]?.toLowerCase()] || 1))
            .sort((a, b) => a - b);
    }
    function check(original, translated, options = {}) {
        original = plain(original); translated = plain(translated);
        const flags = [], add = (code, message, detail = '') => flags.push({ code, message, detail });
        const sourceSize = original.replace(/\s/g, '').length, targetSize = translated.replace(/\s/g, '').length;
        if (!translated.trim()) add('empty', '译文为空');
        if (sourceSize >= 30 && original.trim() === translated.trim() && options.targetLang === 'zh' && /\b[a-z]{3,}\b/.test(original)) add('untranslated', '译文与原文相同，疑似未翻译');
        if (sourceSize >= 80 && (targetSize / sourceSize < 0.18 || targetSize / sourceSize > 2.5)) add('length', '译文长度异常，核对漏句或重复');
        if (JSON.stringify(numbers(original)) !== JSON.stringify(numbers(translated))) add('numbers', '数字或表示方式发生变化，请核对');
        if (options.targetLang === 'zh') {
            const protectedWords = new Set(allowed);
            for (const term of options.terms || []) for (const word of `${term.source} ${term.target}`.match(latin) || []) protectedWords.add(word);
            const remaining = [...new Set(translated.match(latin) || [])].filter(word => !protectedWords.has(word) && /^[a-z]/.test(word) && !/^[A-Za-z]+[A-Z]/.test(word));
            if (remaining.length) add('english', '疑似残留英文', remaining.join(', '));
            if (/["「」]/.test(translated)) add('quotes', '引号样式未统一');
            if (/\b(?:not|never|without|neither|cannot|can't|no)\b/i.test(original) && !/[不未无非没勿莫]/.test(translated)) add('negation', '否定表达可能改变，请核对语义');
            if (/^[A-Z](?=[\u3400-\u9fff])/.test(translated) || /[\u3400-\u9fff][<>][\u3400-\u9fff]/.test(translated)) add('noise', '疑似多余字符');
        }
        for (const term of options.confirmed || []) {
            if (window.NamedTerms?.contains(original, term.source) && !window.NamedTerms.contains(translated, term.target)) add('term', '未使用已确认译名或被代词替代', `${term.source} → ${term.target}`);
        }
        return flags;
    }
    window.TranslationQuality = { check, numbers };
})();
