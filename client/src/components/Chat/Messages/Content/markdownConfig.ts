import { visit } from 'unist-util-visit';
import type { Root } from 'hast';
import 'katex/contrib/mhchem';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import supersub from 'remark-supersub';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import remarkDirective from 'remark-directive';
import type { PluggableList } from 'unified';
import type { ElementType } from 'react';
import {
  mcpUIResourcePlugin,
  MCPUIResource,
  MCPUIResourceCarousel,
} from '~/components/MCPUIResource';
import { Citation, CompositeCitation, HighlightedText } from '~/components/Web/Citation';
import { langSubset, remarkApproxTilde, remarkSingleDollarMath } from '~/utils';
import { Artifact, artifactPlugin } from '~/components/Artifacts/Artifact';
import { code, a, p, img, table } from './MarkdownComponents';
import { unicodeCitation } from '~/components/Web';

/**
 * Single source of truth for the markdown rendering pipeline, shared by the
 * whole-message renderer and the per-block memoized renderer so both produce
 * identical output.
 *
 * These are exposed as lazily-initialized getters rather than top-level
 * consts on purpose: MarkdownComponents participates in a circular import
 * (MarkdownComponents -> CodeBlock -> Parts -> Markdown -> here ->
 * MarkdownComponents). Reading code/a/... at module-evaluation time throws
 * Cannot access 'code' before initialization under native ESM. Deferring the
 * read to call time (when components render or memoize) sidesteps the
 * temporal dead zone.
 */
/**
 * `latexParsing` (the user setting) gates only the ambiguous single-dollar syntax; the
 * unambiguous `$$`, `\(...\)`, and `\[...\]` delimiters always parse via `remark-math`
 * (aliased to `micromark-extension-llm-math` in vite and jest config).
 */
export const getRemarkPlugins = (latexParsing = true): PluggableList => [
  remarkApproxTilde,
  supersub,
  remarkGfm,
  remarkDirective,
  artifactPlugin,
  [remarkMath, { singleDollarTextMath: false }],
  ...(latexParsing ? [remarkSingleDollarMath] : []),
  unicodeCitation,
  mcpUIResourcePlugin,
];

/** Preserve unlabelled HTML before syntax highlighting guesses a language. */
const markNativeHtml = () => (tree: Root) => {
  visit(tree, 'element', (node) => {
    if (node.tagName !== 'code' || node.properties?.className) return;
    const text = node.children.map((child) => (child.type === 'text' ? child.value : '')).join('');
    if (/^\s*(?:<!doctype|<html)/i.test(text)) {
      node.properties = { ...node.properties, dataNativeHtml: true };
    }
  });
};

export const getRehypePlugins = (): PluggableList => [
  markNativeHtml,
  [rehypeKatex],
  [rehypeHighlight, { detect: true, ignoreMissing: true, subset: langSubset }],
];

export const getMarkdownComponents = (): { [nodeType: string]: ElementType } => ({
  code,
  a,
  p,
  img,
  table,
  artifact: Artifact,
  citation: Citation,
  'highlighted-text': HighlightedText,
  'composite-citation': CompositeCitation,
  'mcp-ui-resource': MCPUIResource,
  'mcp-ui-carousel': MCPUIResourceCarousel,
});
