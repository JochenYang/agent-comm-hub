// Markdown rendering: react-markdown + remark-gfm (GFM tables / strikethrough) +
// rehype-highlight (hljs syntax coloring for code blocks) + rehype-sanitize (XSS allowlist).
//
// Color scheme: uses highlight.js's `github-dark` theme + global CSS overrides to match it
// to the Zinc+Cyan devtools palette (see the .hljs-* overrides in tailwind.css).
//
// Style rules (design-taste-frontend):
// - prose conflicts with the product tone, so @tailwindcss/typography is not introduced; only a
//   minimal set of Tailwind utility classes is written here to constrain paragraphs/lists/code
//   in the devtools mono style.
// - The global font must not be changed; only elements inside the markdown container may be adjusted.

import { type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import 'highlight.js/styles/github-dark.css'

interface Props {
  text: string
  className?: string
}

// Reuse rehype-sanitize's default schema but allow the `class` attribute (hljs needs it to color code)
const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), ['className']],
    span: [...(defaultSchema.attributes?.span ?? []), ['className']],
  },
}

/**
 * Renders a markdown text as a devtools-styled React tree.
 * Strict allowlist guards against XSS; code blocks are hljs-colored.
 */
export function Markdown({ text, className }: Props): ReactNode {
  return (
    <div
      className={
        className ??
        'markdown-body font-mono text-xs leading-relaxed text-foreground/90 [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5 [&_a]:text-info [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-2 [&_blockquote]:text-muted-foreground [&_table]:border-collapse [&_th]:border [&_th]:border-border [&_th]:px-1.5 [&_th]:py-0.5 [&_td]:border [&_td]:border-border [&_td]:px-1.5 [&_td]:py-0.5 [&_h1]:mt-2 [&_h1]:mb-1 [&_h1]:text-sm [&_h2]:mt-2 [&_h2]:mb-1 [&_h2]:text-sm [&_h3]:mt-1 [&_h3]:mb-1 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-background [&_pre]:p-2 [&_pre]:text-foreground [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_code:not(pre_code)]:rounded [&_code:not(pre_code)]:bg-background [&_code:not(pre_code)]:px-1 [&_code:not(pre_code)]:py-0.5 [&_code:not(pre_code)]:text-info'
      }
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, schema], rehypeHighlight]}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
