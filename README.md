# MicroTech Summarizer

A browser-based tool for turning lecture notes, technical PDFs, literary excerpts, and general documents into structured summaries.

## Features

- Extract selectable text from PDFs in the browser or paste text directly.
- Choose a context for engineering, physics and mathematics, humanities and business, literature, or general documents.
- Choose concise, balanced, or detailed summaries.
- Organize results with Markdown headings, paragraphs, lists, and tables. Mathematical expressions are rendered in the preview.
- Export a print-ready PDF with browser-native wrapping, repeated table headers, and rendered math; use the print dialog's “Save as PDF” option.
- Split long inputs into sections and consolidate them without silently dropping the rest of the document.

## Use

Open `index.html` in a modern browser, choose a subject, enter a Hugging Face user access token with Inference Providers permission, then upload a text-based PDF or paste text. Select the desired summary detail before starting. Scanned PDFs require OCR before their text can be extracted.

The app uses Hugging Face's OpenAI-compatible Inference Providers chat completion endpoint with `google/gemma-2-2b-it`. The user's selected text is sent to Hugging Face for summarization. The token is held in the page and is not saved by this static app. Do not use a token you cannot safely enter in the browser.

## Notes

- The interface is a static client-side app; it does not require a build step. Serve it over HTTP so the local summarization core can load correctly.
- CDN access is required for the UI libraries, PDF processing, Markdown rendering, mathematical typesetting, and PDF export.
- PDF text extraction cannot read image-only scans. Convert scans with OCR first.
- AI summaries can omit or misinterpret details. Check equations, calculations, and important claims against the original source.

## Development checks

Run the mocked pipeline and browser-flow tests with `node --test tests/pipeline.test.js`. Serve the static app with `python3 -m http.server` and open it in a browser. No package install or build step is required.
