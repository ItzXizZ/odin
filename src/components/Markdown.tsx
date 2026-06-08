import { memo } from 'react'

import ReactMarkdown from 'react-markdown'

import remarkGfm from 'remark-gfm'

import remarkMath from 'remark-math'

import rehypeKatex from 'rehype-katex'



interface MarkdownProps {

  children: string

  className?: string

  /** Tailwind text-size class applied to body text, e.g. "text-xs" */

  size?: string

}



/**

 * Claude commonly emits LaTeX with \( \) and \[ \] delimiters in addition to

 * $ and $$. remark-math only understands the dollar form, so normalise first.

 */

function normalizeMath(input: string): string {

  return input

    .replace(/\\\[([\s\S]+?)\\\]/g, (_, body) => `\n$$\n${body.trim()}\n$$\n`)

    .replace(/\\\(([\s\S]+?)\\\)/g, (_, body) => `$${body.trim()}$`)

}



function MarkdownImpl({ children, className = '', size = 'text-sm' }: MarkdownProps) {

  return (

    <div className={`scribe-md ${size} ${className}`}>

      <ReactMarkdown

        remarkPlugins={[remarkGfm, remarkMath]}

        rehypePlugins={[rehypeKatex]}

        components={{

          a: ({ node, ...props }) => (

            <a {...props} target="_blank" rel="noopener noreferrer" />

          ),

          code: ({ node, className: cls, children, ...props }) => {

            const isBlock = /language-/.test(cls || '')

            if (isBlock) {

              return (

                <code className={`scribe-code-block ${cls || ''}`} {...props}>

                  {children}

                </code>

              )

            }

            return (

              <code className="scribe-code-inline" {...props}>

                {children}

              </code>

            )

          },

        }}

      >

        {normalizeMath(children)}

      </ReactMarkdown>

    </div>

  )

}



export default memo(MarkdownImpl)

