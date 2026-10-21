'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const Core = require('../summarizer-core.js');

const insuranceNotes = `# Fundamentals of Actuarial Science: Insurance

## Definition of Insurance
Insurance transfers specified financial risks from a policyholder to an insurer in exchange for a premium. The insurer pools premiums to pay covered claims under the contract.

## Types of insurance contracts
- Life insurance pays a benefit on death or survival, subject to the policy terms.
- General insurance covers losses such as property damage, liability, and motor accidents.

## Players in the insurance sector
| Player | Role |
| --- | --- |
| Insurer | Accepts covered risk and pays valid claims. |
| Policyholder | Pays premiums and follows policy conditions. |

## Characteristics of insurable risk
- Loss must be measurable and sufficiently accidental.
- A large pool of similar exposures supports credible loss estimates.

## Quick Revision
- Premiums fund a pool that pays covered claims.
- Coverage and exclusions are defined by the contract.`;

function pdfLine(text, top, x = 48, fontSize = 10) {
    return { text, top, x };
}

function item(text, x, y, width = text.length * 5) {
    return { str: text, transform: [fontSize(), 0, 0, fontSize(), x, y], width };
}

function fontSize() { return 10; }

function mockMarkdown(value) {
    const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    return value.split('\n').map(line => {
        if (/^# /.test(line)) return `<h1>${escape(line.slice(2))}</h1>`;
        if (/^## /.test(line)) return `<h2>${escape(line.slice(3))}</h2>`;
        if (/^### /.test(line)) return `<h3>${escape(line.slice(4))}</h3>`;
        if (/^[-*+] /.test(line)) return `<li>${escape(line.slice(2))}</li>`;
        return line.trim() ? `<p>${escape(line)}</p>` : '';
    }).join('');
}

function makeBrowserHarness({ fetchImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: insuranceNotes } }] }) }), pdfjs } = {}) {
    const elements = new Map();
    const alerts = [];
    const clicks = new Map();
    let subjectCards = [];
    const printJobs = [];
    class Element {
        constructor(id = '') {
            this.id = id; this.value = ''; this.textContent = ''; this.innerHTML = '';
            this.disabled = false; this.files = []; this.style = {}; this.listeners = {};
            const classes = new Set();
            this.classList = { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) };
        }
        addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
        click() { for (const fn of this.listeners.click || []) fn.call(this, { target: this }); }
        scrollTo() {}
    }
    const document = {
        getElementById(id) { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); },
        querySelectorAll(selector) {
            if (selector !== '.subject-card') return [];
            if (subjectCards.length) return subjectCards;
            subjectCards = ['Microprocessor Technology Control and Instrumentation', 'PHYSICS AND MATHEMATICS RELATED COURSES', 'Theory/business and other philosopy related course', 'Literature and novels', 'General and professional documents'].map(subject => {
                const card = new Element(); card.dataset = { subject }; card.listeners = {};
                return card;
            });
            return subjectCards;
        },
        addEventListener(name, fn) { clicks.set(name, fn); }
    };
    const window = {
        MathJax: null,
        open() {
            const job = { html: '' };
            job.document = { open() {}, write(html) { job.html = html; }, close() {} };
            printJobs.push(job);
            return job;
        }
    };
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    const appScript = scripts.at(-1)?.[1];
    assert.ok(appScript, 'inline application script exists');
    const context = {
        window,
        document,
        lucide: { createIcons() {} },
        DOMPurify: { sanitize: value => value },
        marked: { parse: mockMarkdown },
        MicroTechSummarizerCore: Core,
        pdfjsLib: pdfjs || {},
        fetch: fetchImpl,
        AbortController,
        alert: message => alerts.push(String(message)),
        console: { error() {}, log() {}, warn() {} },
        Date,
        Math,
        JSON,
        Set,
        Map,
        Array,
        String,
        Number,
        Error,
        Promise,
        RegExp,
        globalThis: null
    };
    context.globalThis = context;
    vm.runInNewContext(`${appScript}\nglobalThis.__app = { summarizeText, summarizeChunk, processPDF, beginRun, resetUpload, exportSummaryPdf, showResults, getState: () => ({ summaryText, extractedText, selectedSubject, generationId }), setSubject: value => { selectedSubject = value; }, setSummary: value => { summaryText = value; }, element: id => document.getElementById(id), chooseSubject: value => { const card = globalThis.__subjectCards.find(entry => entry.dataset.subject === value); card.listeners.click[0].call(card); } }; globalThis.__subjectCards = document.querySelectorAll('.subject-card');`, context, { timeout: 3000 });
    return { context, elements, alerts, printJobs, document };
}

test('short pasted source makes one synthesis request and accepts a structured summary', async () => {
    let calls = 0;
    const harness = makeBrowserHarness({ fetchImpl: async () => {
        calls++;
        return { ok: true, json: async () => ({ choices: [{ message: { content: insuranceNotes } }] }) };
    } });
    harness.context.__app.beginRun();
    const source = 'Insurance pools premiums to compensate policyholders for covered losses. Contracts define coverage, exclusions, and claim conditions. Risk pooling supports predictable claim funding.';
    await harness.context.__app.summarizeText(source, 0, 'hf_mock', harness.context.__app.getState().generationId);
    assert.equal(calls, 1);
    assert.match(harness.context.__app.getState().summaryText, /^# Fundamentals/m);
    assert.equal(harness.elements.get('resultsSection').classList.contains('hidden'), false);
});

test('PDF.js items are arranged by position and meaningful item boundaries', () => {
    const page = Core.assemblePdfPage([
        item('second', 110, 700), item('first', 50, 700), item('next line', 50, 680)
    ], 792);
    assert.deepEqual(page.lines.map(line => line.text), ['first second', 'next line']);
});

test('multi-page extraction removes only repeated margin metadata and flags scanned text', () => {
    const pages = [1, 2, 3].map(number => ({ height: 792, lines: [
        pdfLine('Coastal University | Actuarial Science', 24),
        pdfLine(`Page ${number} of 3`, 773),
        pdfLine(`Insurance transfers specified financial risks to an insurer on page ${number}.`, 150),
        pdfLine('The policy defines covered events and exclusions for a contract holder.', 170)
    ] }));
    const result = Core.extractDocumentPages(pages);
    assert.equal(result.removedHeaderLines, 6);
    assert.doesNotMatch(result.text, /Coastal University|Page \d/);
    assert.match(result.text, /Insurance transfers specified financial risks/);
    const scanned = Core.extractDocumentPages([{ height: 792, lines: [pdfLine('x', 130), pdfLine('y', 155)] }]);
    assert.ok(scanned.warnings.some(warning => /scanned or image-based/.test(warning)));
});

test('page extraction preserves equations, units, lists and Markdown table data', () => {
    const source = '## Expected value\nE[X] = Σ xᵢpᵢ; variance is σ².\n\n| Loss | Probability |\n| --- | ---: |\n| 100 | 0.25 |';
    const clean = Core.normalizeText(source);
    assert.match(clean, /Σ xᵢpᵢ/);
    assert.match(clean, /σ²/);
    assert.match(clean, /0\.25/);
});

test('multi-column layouts produce a reading-order warning instead of silently claiming certainty', () => {
    const items = Array.from({ length: 12 }, (_, index) => item(`Column sentence ${index + 1} explains a distinct insurance concept.`, index % 2 ? 350 : 48, 680 - Math.floor(index / 2) * 36, 170));
    const page = Core.assemblePdfPage(items, 792, 612);
    assert.equal(page.readingOrderUncertain, true);
    const result = Core.extractDocumentPages([{ ...page, height: 792 }]);
    assert.ok(result.warnings.some(warning => /reading order/.test(warning)));
});

test('long documents get stable non-overlapping chunks and one consolidated final result', async () => {
    const source = Array.from({ length: 50 }, (_, index) => `Section ${index + 1}: Insurable risk uses measurable losses and a broad pool of similar exposures. Premiums support valid claims while exclusions remain defined in the policy.`).join('\n\n');
    const sourceIds = [];
    const stages = [];
    const sourceChunks = Core.splitSourceIntoChunks(source);
    assert.equal(sourceChunks.map(chunk => chunk.text).join('\n\n'), Core.normalizeText(source));
    const result = await Core.summarizeDocument(source, async (chunk, task) => {
        stages.push(task.stage);
        if (task.stage === 'source') { sourceIds.push(task.id); return `## Risk concept ${task.index}\nA broad pool of similar exposures makes loss estimates more stable and supports insurance pricing.`; }
        return insuranceNotes;
    });
    assert.ok(result.sourceChunks > 1);
    assert.equal(new Set(sourceIds).size, sourceIds.length);
    assert.ok(stages.includes('consolidate'));
    assert.match(result.summary, /^# Fundamentals/m);
    assert.doesNotMatch(result.summary, /<!-- source-|## Risk concept/);
});

test('repeated paragraphs trigger one controlled repair rather than silent deletion', async () => {
    const source = 'Insurance pools premiums to fund covered claims. Policy terms define the contract. Insurers assess risks before offering cover. Claim evidence is reviewed. Exclusions limit specified losses.';
    const repeated = '# Insurance notes\n\n## Risk pooling\nPremium pools finance covered claims across policyholders and protect against uncertain loss outcomes with actuarial assessment.\n\n## Risk pooling\nPremium pools finance covered claims across policyholders and protect against uncertain loss outcomes with actuarial assessment.';
    let repairCalls = 0;
    const result = await Core.summarizeDocument(source, async (_text, task) => {
        if (task.stage === 'repair') { repairCalls++; return insuranceNotes; }
        return repeated;
    });
    assert.equal(repairCalls, 1);
    assert.match(result.summary, /^# Fundamentals/m);
});

test('duplicate detection catches repeated headings, paragraphs and copied sentences', () => {
    const copied = '# Notes\n\n## Definition\nInsurance pools premiums to fund covered claims under policy conditions.\n\n## Definition\nInsurance pools premiums to fund covered claims under policy conditions.';
    const report = Core.validateSummary('Insurance pools premiums to fund covered claims under policy conditions.', copied);
    assert.equal(report.valid, false);
    assert.ok(report.issues.some(issue => /heading/.test(issue)));
    assert.ok(report.issues.some(issue => /paragraph/.test(issue)));
});

test('empty source, empty model result, malformed response and network failure cannot show success', async () => {
    await assert.rejects(() => Core.summarizeDocument('  ', async () => 'never'), /no readable source text/i);
    await assert.rejects(() => Core.summarizeDocument('A source with enough text to process.', async () => ''), /empty result/i);

    for (const fetchImpl of [
        async () => { throw new Error('offline'); },
        async () => ({ ok: true, json: async () => ({ choices: [{}] }) }),
        async () => ({ ok: false, status: 503, json: async () => ({ error: { message: 'provider unavailable' } }) })
    ]) {
        const harness = makeBrowserHarness({ fetchImpl });
        harness.context.__app.beginRun();
        const generation = harness.context.__app.getState().generationId;
        await harness.context.__app.summarizeText('This source contains a statement about pooling risk and insurance contracts.', 0, 'hf_mock', generation);
        assert.equal(harness.context.__app.getState().summaryText, '');
        assert.equal(harness.elements.get('resultsSection').classList.contains('hidden'), true);
        assert.ok(harness.alerts.length > 0);
    }
});

test('PDF upload strips repeated headers and footers before passing a single document to the model', async () => {
    const pageText = (page) => {
        const rows = [
            ['Coastal University - Actuarial Science - Lecture 1', 770],
            [`Page ${page} of 2`, 15],
            ['Insurance transfers financial risk from a policyholder to an insurer.', 680],
            ['The insurer pools premiums and pays claims covered by the policy.', 660],
            ['A measurable loss and a broad risk pool support sustainable insurance.', 640],
            ['Policy conditions and exclusions determine the limits of coverage.', 620],
            ['Actuarial methods estimate expected claims using frequency and severity.', 600],
            ['Risk selection and pricing require reliable historical evidence.', 580],
            ['Life insurance and property insurance cover different exposures.', 560],
            ['An insured submits evidence when a covered loss occurs.', 540],
            ['The insurer investigates and settles valid claims under the contract.', 520],
            ['Premium income funds the expected cost of claims and expenses.', 500],
            ['Pooling independent risks reduces variation in aggregate losses.', 480],
            ['A deductible is the amount borne by the policyholder first.', 460],
            ['An exclusion identifies a loss not covered by the contract.', 440],
            ['Reinsurance transfers part of an insurer risk to another insurer.', 420],
            ['Moral hazard may change behavior after insurance is purchased.', 400],
            ['Adverse selection occurs when higher risks seek more coverage.', 380],
            ['Underwriting evaluates risk before a policy is accepted.', 360],
            ['Insurance supports financial recovery after uncertain losses.', 340],
            ['The policy schedule records the selected cover and premium.', 320]
        ];
        return rows.map(([text, y]) => item(text, 48, y, text.length * 4.2));
    };
    const pdfjs = { getDocument: () => ({ promise: Promise.resolve({
        numPages: 2,
        getPage: async pageNumber => ({ view: [0, 0, 612, 792], getTextContent: async () => ({ items: pageText(pageNumber) }) })
    }) }) };
    let payload;
    const harness = makeBrowserHarness({ pdfjs, fetchImpl: async (_url, options) => {
        payload = JSON.parse(options.body);
        return { ok: true, json: async () => ({ choices: [{ message: { content: insuranceNotes } }] }) };
    } });
    harness.context.__app.element('apiKey').value = 'hf_mock';
    const file = { name: 'insurance-lecture.pdf', arrayBuffer: async () => new ArrayBuffer(8) };
    await harness.context.__app.processPDF(file);
    assert.ok(payload.messages[1].content.includes('Insurance transfers financial risk'));
    assert.doesNotMatch(payload.messages[1].content, /Coastal University|Page 1 of 2/);
    assert.equal(harness.context.__app.getState().summaryText, insuranceNotes);
    assert.match(harness.elements.get('processLog').textContent, /Removed .* repeated margin\/header\/footer lines/);
});

test('a second summary replaces stale content and selection/detail values reach the request', async () => {
    const requests = [];
    let requestNumber = 0;
    const harness = makeBrowserHarness({ fetchImpl: async (_url, options) => {
        requests.push(JSON.parse(options.body));
        requestNumber++;
        const content = requestNumber === 1 ? insuranceNotes : '# Quarterly Report\n\n## Findings\nRevenue increased and operating costs changed during the quarter.';
        return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
    } });
    harness.context.__app.element('detailLevel').value = 'detailed';
    harness.context.__app.chooseSubject('Literature and novels');
    harness.context.__app.beginRun();
    await harness.context.__app.summarizeText('A novel follows a family through change. Its central conflict concerns memory and responsibility.', 0, 'hf_mock', harness.context.__app.getState().generationId);
    const first = harness.context.__app.getState().summaryText;
    harness.context.__app.beginRun();
    assert.equal(harness.context.__app.getState().summaryText, '');
    await harness.context.__app.summarizeText('A report compares quarterly revenue and identifies a change in operating costs.', 0, 'hf_mock', harness.context.__app.getState().generationId);
    assert.match(harness.context.__app.getState().summaryText, /^# Quarterly Report/m);
    assert.notEqual(first, '');
    assert.equal(requests.at(-1).max_tokens, 1700);
    assert.match(requests.at(-1).messages[0].content, /For literature/i);
});

test('concise, balanced and detailed selections set corresponding model output limits', async () => {
    const limits = [];
    const harness = makeBrowserHarness({ fetchImpl: async (_url, options) => {
        limits.push(JSON.parse(options.body).max_tokens);
        return { ok: true, json: async () => ({ choices: [{ message: { content: insuranceNotes } }] }) };
    } });
    for (const [detail, expected] of [['concise', 850], ['balanced', 1250], ['detailed', 1700]]) {
        harness.context.__app.element('detailLevel').value = detail;
        harness.context.__app.beginRun();
        await harness.context.__app.summarizeChunk('A technical source with useful definitions and formulas.', 'hf_mock', 'Engineering context.', { stage: 'source', total: 1 }, harness.context.__app.getState().generationId);
        assert.equal(limits.at(-1), expected);
    }
});

test('preview and PDF export use the same sanitized final summary and single title', () => {
    const harness = makeBrowserHarness();
    harness.context.__app.beginRun();
    harness.context.__app.setSummary('# Fundamentals of Insurance\n\nTable notes.');
    harness.context.__app.showResults(4, 2);
    const previewHtml = harness.context.__app.element('previewContent').innerHTML;
    harness.context.__app.exportSummaryPdf();
    const html = harness.printJobs[0].html;
    assert.equal((html.match(/<h1>Fundamentals of Insurance<\/h1>/g) || []).length, 1);
    assert.match(html, /<title>Fundamentals of Insurance/);
    assert.ok(html.includes(previewHtml));
    assert.match(html, /table-header-group/);
    assert.match(html, /break-inside:avoid/);
    assert.match(html, /MicroTech Summarizer/);
});

test('summary PDF print template keeps math, metadata outside the notes and Unicode-safe browser typography', () => {
    const html = Core.buildPrintableHtml({
        summaryHtml: '<h1>Risk Models</h1><p>Expected loss: $E[X]=\\sum x_i p_i$; variance: $\\sigma^2$.</p><table><thead><tr><th>Value</th></tr></thead><tbody><tr><td>μ = 2.5</td></tr></tbody></table>',
        subject: 'Physics & Mathematics', filename: 'risk-notes.pdf', date: '2026-10-21'
    });
    assert.match(html, /Expected loss/);
    assert.match(html, /μ = 2\.5/);
    assert.match(html, /Generated:<\/strong> 2026-10-21/);
    assert.match(html, /break-after:avoid-page/);
    assert.match(html, /table-header-group/);
    assert.match(html, /counter\(page\)/);
});
