// One-time vendor bundler. Produces self-contained ESM bundles in web/vendor/
// so the frontend needs no build step and no CDN at runtime.
import { build } from 'esbuild';
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'web', 'vendor');
mkdirSync(out, { recursive: true });

// --- CodeMirror 6 bundle ---
const cmEntry = `
export { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
export { EditorState, Compartment } from '@codemirror/state';
export { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands';
export { searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
export { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching, foldGutter, indentUnit } from '@codemirror/language';
export { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete';
export { javascript } from '@codemirror/lang-javascript';
export { python } from '@codemirror/lang-python';
export { markdown } from '@codemirror/lang-markdown';
export { html } from '@codemirror/lang-html';
export { css } from '@codemirror/lang-css';
export { json } from '@codemirror/lang-json';
export { oneDark } from '@codemirror/theme-one-dark';
export { basicSetup } from 'codemirror';
`;
writeFileSync(join(out, '_cm-entry.mjs'), cmEntry);
await build({
  entryPoints: [join(out, '_cm-entry.mjs')],
  bundle: true, format: 'esm', minify: true,
  outfile: join(out, 'codemirror.js'),
  absWorkingDir: root, logLevel: 'warning',
});

// --- Markdown stack: marked + DOMPurify + highlight.js (common langs) ---
const mdEntry = `
export { marked } from 'marked';
export { default as DOMPurify } from 'dompurify';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import markdown from 'highlight.js/lib/languages/markdown';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import java from 'highlight.js/lib/languages/java';
import sql from 'highlight.js/lib/languages/sql';
import yaml from 'highlight.js/lib/languages/yaml';
import diff from 'highlight.js/lib/languages/diff';
for (const [n, l] of Object.entries({ javascript, typescript, python, bash, json, xml, css, markdown, rust, go, c, cpp, java, sql, yaml, diff })) hljs.registerLanguage(n, l);
hljs.registerAliases(['js','jsx','mjs','cjs'], { languageName: 'javascript' });
hljs.registerAliases(['ts','tsx'], { languageName: 'typescript' });
hljs.registerAliases(['sh','shell','zsh'], { languageName: 'bash' });
hljs.registerAliases(['html'], { languageName: 'xml' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });
hljs.registerAliases(['py'], { languageName: 'python' });
export { hljs };
`;
writeFileSync(join(out, '_md-entry.mjs'), mdEntry);
await build({
  entryPoints: [join(out, '_md-entry.mjs')],
  bundle: true, format: 'esm', minify: true,
  outfile: join(out, 'md.js'),
  absWorkingDir: root, logLevel: 'warning',
});

// --- xterm (UMD, loaded via <script>) + css ---
copyFileSync(join(root, 'node_modules/@xterm/xterm/lib/xterm.js'), join(out, 'xterm.js'));
copyFileSync(join(root, 'node_modules/@xterm/xterm/css/xterm.css'), join(out, 'xterm.css'));
copyFileSync(join(root, 'node_modules/@xterm/addon-fit/lib/addon-fit.js'), join(out, 'xterm-addon-fit.js'));

console.log('vendor bundles written to web/vendor/');
