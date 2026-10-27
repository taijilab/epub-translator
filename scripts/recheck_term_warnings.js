/* Recheck saved warnings with the current matcher; no API or browser access. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const environment = { window: {}, document: { addEventListener() {} } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/terms.js'), 'utf8'), environment);
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const cleared = [], pending = [];
for (const warning of report.warnings || []) {
    const matched = warning.expected && environment.window.NamedTerms.contains(warning.translated || '', warning.expected);
    (matched ? cleared : pending).push(warning);
}
const result = {
    method: 'Offline matching against saved translation text; original API output is unchanged.',
    original_warning_count: (report.warnings || []).length,
    cleared_boundary_false_positives: cleared.length,
    pending_candidates: pending.length,
    pending_are_not_confirmed_translation_errors: true,
    cleared, pending
};
fs.writeFileSync(process.argv[3], JSON.stringify(result, null, 2));
console.log(JSON.stringify({ original: result.original_warning_count, cleared: cleared.length, pending: pending.length }));
