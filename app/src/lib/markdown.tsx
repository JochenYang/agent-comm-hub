// Markdown 渲染：react-markdown + remark-gfm (GFM 表格 / strikethrough) +
// rehype-highlight (代码块 hljs 着色) + rehype-sanitize (XSS 白名单)。
//
// 颜色风格：用 highlight.js 的 `github-dark` 主题 + 全局 CSS override 把它
// 调成跟 Zinc+Cyan 主题一致的 devtool 色板（见 tailwind.css 的 .hljs-* override）。
//
// 风格规则（design-taste-frontend）：
// - prose 与产品调性冲突，所以不引入 @tailwindcss/typography；只在这一层写
//   最小的 Tailwind utility class 把段落/列表/code 约束在 devtool mono 风里。
// - 不允许改全局 font；只允许调整 markdown 容器内部的元素。

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

// 复用 rehype-sanitize 默认 schema,但允许 `class` 属性(hljs 需要它上色)
const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), ['className']],
    span: [...(defaultSchema.attributes?.span ?? []), ['className']],
  },
}

/**
 * 渲染一段 markdown 文本为 devtool 风格的 React 树。
 * 严格白名单防 XSS,代码块走 hljs 着色。
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
