(function (root) {
    'use strict';

    const DEFAULT_SOURCE_LIMIT = 5200;
    const DEFAULT_MERGE_LIMIT = 7600;

    function normalizeLine(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function normalizeText(value) {
        return String(value || '')
            .replace(/\r/g, '')
            .replace(/[\u00a0\u2007\u202f]/g, ' ')
            .replace(/[\t ]+/g, ' ')
            .replace(/ *\n */g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    function assemblePdfPage(items, pageHeight, pageWidth = pageHeight) {
        const positioned = (items || []).filter(item => item && typeof item.str === 'string' && item.str.trim());
        const fallback = positioned.map(item => item.str).join(' ');
        const hasPositions = positioned.length > 0 && positioned.every(item => Array.isArray(item.transform) && Number.isFinite(item.transform[4]) && Number.isFinite(item.transform[5]));
        if (!hasPositions) {
            return { lines: normalizeText(fallback).split('\n').map(text => ({ text, top: null, x: null })), readingOrderUncertain: true };
        }

        const rows = [];
        for (const item of positioned) {
            const x = item.transform[4];
            const y = item.transform[5];
            const fontSize = Math.max(1, Math.abs(item.transform[3]) || 10);
            const top = Number.isFinite(pageHeight) ? pageHeight - y : -y;
            let row = rows.find(candidate => Math.abs(candidate.y - y) <= Math.max(1.5, fontSize * 0.28));
            if (!row) { row = { y, top, items: [] }; rows.push(row); }
            row.items.push({ x, width: Number(item.width) || 0, fontSize, text: item.str });
        }

        rows.sort((a, b) => b.y - a.y);
        const lines = rows.map(row => {
            row.items.sort((a, b) => a.x - b.x);
            let text = '';
            let rightEdge = null;
            for (const item of row.items) {
                const value = item.text;
                if (text && rightEdge !== null && item.x - rightEdge > item.fontSize * 0.18 && !/\s$/.test(text) && !/^\s/.test(value)) text += ' ';
                text += value;
                rightEdge = Math.max(rightEdge === null ? item.x : rightEdge, item.x + item.width);
            }
            return { text: normalizeLine(text), top: row.top, x: Math.min(...row.items.map(item => item.x)) };
        }).filter(line => line.text);

        const bodyRows = lines.filter(line => line.top !== null && pageHeight > 0 && line.top > pageHeight * 0.14 && line.top < pageHeight * 0.86);
        const leftStarts = bodyRows.filter(line => line.x < pageWidth * 0.4).length;
        const rightStarts = bodyRows.filter(line => line.x > pageWidth * 0.54).length;
        const rowsWithColumnGaps = rows.filter(row => {
            if (row.top <= pageHeight * 0.14 || row.top >= pageHeight * 0.86) return false;
            const ordered = row.items.slice().sort((a, b) => a.x - b.x);
            return ordered.slice(1).some((item, index) => item.x - (ordered[index].x + ordered[index].width) > pageWidth * 0.12);
        }).length;
        const readingOrderUncertain = (bodyRows.length >= 10 && leftStarts >= 4 && rightStarts >= 4) || rowsWithColumnGaps >= 4;
        return { lines, readingOrderUncertain };
    }

    function normalizedHeaderKey(line) {
        return normalizeLine(line).toLowerCase().replace(/\b\d+\b/g, '#').replace(/[|:.,]+/g, '').trim();
    }

    function extractDocumentPages(pages) {
        const allPages = pages || [];
        const counts = new Map();
        const eligible = [];
        for (let pageIndex = 0; pageIndex < allPages.length; pageIndex++) {
            const page = allPages[pageIndex];
            for (const line of page.lines || []) {
                if (line.top === null || !page.height) continue;
                if (line.top <= page.height * 0.14 || line.top >= page.height * 0.86) {
                    const key = normalizedHeaderKey(line.text);
                    if (!key) continue;
                    eligible.push({ pageIndex, line, key });
                    counts.set(key, (counts.get(key) || 0) + 1);
                }
            }
        }
        const repeatThreshold = allPages.length >= 2 ? Math.max(2, Math.ceil(allPages.length * 0.6)) : Infinity;
        const repeated = new Set(Array.from(counts).filter(([, count]) => count >= repeatThreshold).map(([key]) => key));
        const repeatedByPage = new Map();
        for (const entry of eligible) {
            if (!repeated.has(entry.key)) continue;
            if (!repeatedByPage.has(entry.pageIndex)) repeatedByPage.set(entry.pageIndex, new Set());
            repeatedByPage.get(entry.pageIndex).add(entry.line);
        }

        const warnings = [];
        let removedHeaderLines = 0;
        const output = allPages.map((page, index) => {
            const removed = repeatedByPage.get(index) || new Set();
            const lines = (page.lines || []).filter(line => {
                const label = normalizeLine(line.text).match(/^(?:(page)\s+)?(\d{1,4})(?:\s*(?:of|\/)\s*(\d{1,4}))?$/i);
                const inMargin = line.top !== null && page.height && (line.top <= page.height * 0.14 || line.top >= page.height * 0.86);
                const pageLabel = Boolean(inMargin && label && (label[1] || Number(label[2]) === index + 1 || Number(label[2]) === allPages.length));
                if (removed.has(line) || pageLabel) { removedHeaderLines++; return false; }
                return true;
            }).map(line => line.text).filter(Boolean);
            if (page.readingOrderUncertain) warnings.push(`Page ${index + 1} has a multi-column or spatial layout; verify the extracted reading order.`);
            return lines.join('\n');
        }).filter(Boolean).join('\n\n');

        if (removedHeaderLines) warnings.push(`Removed ${removedHeaderLines} repeated margin/header/footer lines.`);
        const clean = normalizeText(output);
        const wordCount = clean.match(/[\p{L}\p{N}]+/gu)?.length || 0;
        if (wordCount < 20) warnings.push('Very little selectable text was extracted. This PDF may be scanned or image-based; use OCR before summarizing.');
        const tokens = clean.match(/[A-Za-z]+/g) || [];
        const oneLetterRatio = tokens.length ? tokens.filter(word => word.length === 1).length / tokens.length : 0;
        if (tokens.length > 40 && oneLetterRatio > 0.38) warnings.push('Many words appear split into single characters; PDF text spacing may be unreliable. Check the source before relying on the summary.');
        return { text: clean, warnings, removedHeaderLines, wordCount };
    }

    function splitUnits(text) {
        const paragraphs = normalizeText(text).split(/\n\s*\n/).map(part => part.trim()).filter(Boolean);
        const units = [];
        for (const paragraph of paragraphs) {
            if (paragraph.length <= DEFAULT_SOURCE_LIMIT) { units.push(paragraph); continue; }
            const sentences = paragraph.split(/(?<=[.!?])\s+(?=[A-Z0-9(])/);
            if (sentences.length === 1) {
                for (let index = 0; index < paragraph.length; index += DEFAULT_SOURCE_LIMIT) units.push(paragraph.slice(index, index + DEFAULT_SOURCE_LIMIT));
            } else {
                let current = '';
                for (const sentence of sentences) {
                    if (current && current.length + sentence.length + 1 > DEFAULT_SOURCE_LIMIT) { units.push(current); current = ''; }
                    current += (current ? ' ' : '') + sentence;
                }
                if (current) units.push(current);
            }
        }
        return units;
    }

    function packUnits(units, maxLength) {
        const chunks = [];
        let current = '';
        for (const unit of units) {
            if (current && current.length + unit.length + 2 > maxLength) { chunks.push(current); current = ''; }
            current += (current ? '\n\n' : '') + unit;
        }
        if (current) chunks.push(current);
        return chunks;
    }

    function splitSourceIntoChunks(text, maxLength = DEFAULT_SOURCE_LIMIT) {
        const units = splitUnits(text);
        return packUnits(units, maxLength).map((text, index) => ({ id: `source-${String(index + 1).padStart(4, '0')}`, text }));
    }

    function groupSummaries(summaries, maxLength = DEFAULT_MERGE_LIMIT) {
        return packUnits(summaries.map(item => `<!-- ${item.id} -->\n${item.text}`), maxLength).map((text, index) => ({
            id: `merge-${String(index + 1).padStart(3, '0')}`,
            text,
            sourceIds: summaries.filter(item => text.includes(`<!-- ${item.id} -->`)).map(item => item.id)
        }));
    }

    function markdownPlainText(markdown) {
        return String(markdown || '').replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/^\s*[-*+]\s+/gm, '').replace(/^\s*\d+[.)]\s+/gm, '').replace(/\|/g, ' ').replace(/[*_`>#]/g, '').replace(/\s+/g, ' ').trim();
    }

    function validateSummary(source, summary) {
        const issues = [];
        const markdown = String(summary || '').trim();
        const body = markdown.replace(/^\s{0,3}#{1,6}\s+[^\n]+\n?/, '').trim();
        if (!body) issues.push('The AI returned an empty summary or a title without any notes.');

        const paragraphs = markdown.split(/\n\s*\n/).map(part => normalizeLine(part).toLowerCase()).filter(part => part.length >= 70);
        const paragraphCounts = new Map();
        for (const paragraph of paragraphs) paragraphCounts.set(paragraph, (paragraphCounts.get(paragraph) || 0) + 1);
        if (Array.from(paragraphCounts.values()).some(count => count > 1)) issues.push('The summary contains an identical paragraph more than once.');

        const headings = (markdown.match(/^\s{0,3}#{1,6}\s+(.+)$/gm) || []).map(heading => normalizeLine(heading.replace(/^\s*#+\s*/, '')).toLowerCase());
        const titleCount = (markdown.match(/^\s{0,3}#\s+.+$/gm) || []).length;
        if (titleCount !== 1) issues.push('The final notes must contain exactly one document title.');
        const lines = markdown.split('\n');
        for (let index = 0; index < lines.length; index++) {
            const current = lines[index].match(/^\s{0,3}(#{2,6})\s+(.+)$/);
            if (!current) continue;
            const level = current[1].length;
            let hasContent = false;
            for (let next = index + 1; next < lines.length; next++) {
                const followingHeading = lines[next].match(/^\s{0,3}(#{1,6})\s+/);
                if (followingHeading && followingHeading[1].length <= level) break;
                if (lines[next].trim() && !/^\s*[-|: ]+$/.test(lines[next])) hasContent = true;
            }
            if (!hasContent) issues.push(`The section "${normalizeLine(current[2])}" has no content.`);
        }
        const headingCounts = new Map();
        for (const heading of headings) headingCounts.set(heading, (headingCounts.get(heading) || 0) + 1);
        if (Array.from(headingCounts.values()).some(count => count > 1)) issues.push('The summary repeats a section heading.');

        const sourceSentences = new Set((String(source || '').match(/[^.!?\n]+[.!?]?/g) || []).map(normalizeLine).filter(sentence => sentence.length >= 35).map(sentence => sentence.toLowerCase()));
        const summarySentences = (markdownPlainText(markdown).match(/[^.!?]+[.!?]?/g) || []).map(normalizeLine).filter(sentence => sentence.length >= 35);
        if (summarySentences.length >= 5) {
            const copied = summarySentences.filter(sentence => sourceSentences.has(sentence.toLowerCase())).length;
            if (copied / summarySentences.length >= 0.7) issues.push('Most of the summary repeats source sentences verbatim instead of synthesizing them.');
        }
        return { valid: issues.length === 0, issues };
    }

    async function summarizeDocument(source, summarize, options = {}) {
        const text = normalizeText(source);
        if (!text) throw new Error('There is no readable source text to summarize.');
        if (text.length > 500000) throw new Error('This material exceeds the 500,000 character processing limit. Split it into smaller documents.');
        const sourceLimit = options.sourceLimit || DEFAULT_SOURCE_LIMIT;
        const mergeLimit = options.mergeLimit || DEFAULT_MERGE_LIMIT;
        const chunks = splitSourceIntoChunks(text, sourceLimit);
        let notes = [];
        for (const chunk of chunks) {
            const result = await summarize(chunk.text, { id: chunk.id, stage: 'source', index: notes.length + 1, total: chunks.length });
            if (!String(result || '').trim()) throw new Error(`The model returned an empty result for ${chunk.id}.`);
            notes.push({ id: chunk.id, text: String(result).trim() });
        }

        let pass = 0;
        while (notes.length > 1) {
            if (pass >= 6) throw new Error('The notes could not be consolidated into one reliable summary. Try a smaller document.');
            const groups = groupSummaries(notes, mergeLimit);
            if (groups.length >= notes.length) throw new Error('The model produced oversized section notes that could not be consolidated safely. Try a smaller document.');
            const merged = [];
            for (const group of groups) {
                const result = await summarize(group.text, { id: group.id, stage: 'consolidate', index: merged.length + 1, total: groups.length, sourceIds: group.sourceIds });
                if (!String(result || '').trim()) throw new Error(`The model returned an empty result while consolidating ${group.id}.`);
                merged.push({ id: group.id, text: String(result).trim() });
            }
            notes = merged;
            pass++;
        }

        let finalSummary = notes[0].text;
        let quality = validateSummary(text, finalSummary);
        if (!quality.valid) {
            const repaired = await summarize(text.length <= sourceLimit ? text : finalSummary, {
                id: 'quality-repair', stage: 'repair', draft: finalSummary, issues: quality.issues
            });
            finalSummary = String(repaired || '').trim();
            quality = validateSummary(text, finalSummary);
        }
        if (!quality.valid) throw new Error(`The generated notes did not pass the repetition and content checks: ${quality.issues.join(' ')}`);
        return { summary: finalSummary, sourceChunks: chunks.length, mergePasses: pass, quality };
    }

    function escapeHtml(value) {
        return String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }

    function buildPrintableHtml({ summaryHtml, subject, filename, date, title = 'Summary' }) {
        return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} — MicroTech Summarizer</title>
<script>window.MathJax={tex:{inlineMath:[['$','$'],['\\\\(','\\\\)']],displayMath:[['$$','$$'],['\\\\[','\\\\]']]},options:{skipHtmlTags:['script','noscript','style','textarea','pre','code']}};<\/script>
<script defer src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js"><\/script>
<style>@page{size:A4;margin:20mm 18mm 18mm;@bottom-right{content:"MicroTech Summarizer · " counter(page);font:8pt Arial,sans-serif;color:#64748b}}*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;color:#1f2937;font-size:10.5pt;line-height:1.5}.brand{font-size:9pt;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#4338ca;border-bottom:1px solid #cbd5e1;padding-bottom:8px;margin-bottom:12px}.meta{font-size:9pt;color:#475569;margin-bottom:22px}.meta span{display:inline-block;margin:0 12px 4px 0}.summary-content{overflow-wrap:anywhere}.summary-content h1{font-size:21pt;line-height:1.2;color:#172554;margin:0 0 13px;break-after:avoid-page;overflow-wrap:anywhere}.summary-content h2{font-size:15pt;color:#312e81;margin:18px 0 7px;break-after:avoid-page}.summary-content h3{font-size:12pt;color:#334155;margin:13px 0 5px;break-after:avoid-page}.summary-content p{margin:0 0 9px;orphans:3;widows:3}.summary-content ul,.summary-content ol{padding-left:22px;margin:5px 0 11px}.summary-content li{padding-left:2px;margin:0 0 4px}.summary-content table{width:100%;border-collapse:collapse;margin:11px 0 15px;font-size:9pt;break-inside:auto}.summary-content thead{display:table-header-group}.summary-content tr{break-inside:avoid}.summary-content th,.summary-content td{border:1px solid #94a3b8;padding:6px 7px;text-align:left;vertical-align:top}.summary-content th{background:#eef2ff;color:#312e81}.summary-content blockquote{border-left:3px solid #818cf8;margin:9px 0;padding:4px 10px;color:#475569}.summary-content pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f1f5f9;padding:8px}.summary-content mjx-container{font-size:100%!important}a{color:inherit;text-decoration:none}@media screen{body{max-width:180mm;margin:20px auto;padding:18px;box-shadow:0 2px 20px #cbd5e1}.brand{margin-bottom:14px}}</style></head><body>
<div class="brand">MicroTech Summarizer <span style="font-weight:400">by ZaccyDreamer</span></div><div class="meta"><span><strong>Subject:</strong> ${escapeHtml(subject)}</span><span><strong>Source:</strong> ${escapeHtml(filename)}</span><span><strong>Generated:</strong> ${escapeHtml(date)}</span></div><main class="summary-content">${summaryHtml}</main>
<script>window.addEventListener('load',async()=>{try{if(window.MathJax?.typesetPromise)await MathJax.typesetPromise();}catch(e){}window.focus();window.print();});<\/script></body></html>`;
    }

    const api = { normalizeText, assemblePdfPage, extractDocumentPages, splitSourceIntoChunks, groupSummaries, validateSummary, summarizeDocument, buildPrintableHtml, markdownPlainText };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.MicroTechSummarizerCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
