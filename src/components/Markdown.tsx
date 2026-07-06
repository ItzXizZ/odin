import { memo } from 'react'

import ReactMarkdown from 'react-markdown'

import remarkGfm from 'remark-gfm'

import remarkMath from 'remark-math'

import rehypeKatex from 'rehype-katex'

import { repairMarkdownLineBreaks } from '../lib/aiText'



interface MarkdownProps {

  children: string

  className?: string

  /** Tailwind text-size class applied to body text, e.g. "text-xs" */

  size?: string

  /** When provided, link clicks call this instead of navigating (exploration mode). */

  onLinkClick?: (url: string, x: number, y: number, linkText?: string) => void

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



function MarkdownImpl({ children, className = '', size = 'text-sm', onLinkClick }: MarkdownProps) {

  return (

    <div className={`scribe-md ${size} ${className}`}>

      <ReactMarkdown

        remarkPlugins={[remarkGfm, remarkMath]}

        rehypePlugins={[rehypeKatex]}

        components={{

          a: ({ node, href, children: linkChildren, ...props }) => {

            const extractText = (c: React.ReactNode): string => {

              if (typeof c === 'string') return c

              if (typeof c === 'number') return String(c)

              if (Array.isArray(c)) return c.map(extractText).join('')

              if (c && typeof c === 'object' && 'props' in (c as object)) {

                return extractText((c as React.ReactElement).props.children)

              }

              return ''

            }

            const linkText = extractText(linkChildren)

            return (

              <a

                {...props}

                href={href}

                target={onLinkClick ? undefined : '_blank'}

                rel="noopener noreferrer"

                onClick={

                  onLinkClick && href

                    ? (e) => {

                        e.preventDefault()

                        e.stopPropagation()

                        onLinkClick(href, e.clientX, e.clientY, linkText || undefined)

                      }

                    : undefined

                }

              >

                {linkChildren}

              </a>

            )

          },

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

        {normalizeMath(repairMarkdownLineBreaks(children))}

      </ReactMarkdown>

    </div>

  )

}



export default memo(MarkdownImpl)

