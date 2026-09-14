"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { cn } from "~/lib/utils";
import { GRAMMARS } from "~/lib/highlight";

/**
 * What an agent said, rendered as the markdown it wrote.
 *
 * **Agent output is markdown whether or not anything renders it.** Models emit
 * fenced code, backticked identifiers, bullets and bold, and this page showed all
 * of it as literal text — so a reply containing a patch was a wall of
 * back-ticks and hashes with the answer somewhere inside.
 *
 * **`components/prose.tsx` says a renderer does not ship to either web project,
 * and this does not contradict it.** That file is for documentation baked by
 * `scripts/bake-docs.mjs`: authored content, known at build time, put through an
 * allowlist and injected with `dangerouslySetInnerHTML`. A transcript is the
 * opposite on every count — it arrives at runtime, from the database, written by
 * a model. It cannot be baked, so the choice is a runtime renderer or no
 * rendering at all.
 *
 * It is also the safer of the two paths, which is worth saying because it looks
 * like the riskier one: `react-markdown` builds a React tree and never touches
 * `dangerouslySetInnerHTML`. Raw HTML in the source is inert unless `rehype-raw`
 * is added, and it deliberately is not. Nothing a model writes can become markup
 * here.
 *
 * Styling is by token and not by a typography plugin — the surrounding
 * transcript sets the measure, and a `prose` class would fight it on every
 * margin.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("text-[14px] leading-[1.65]", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        /**
         * Fenced blocks get token colour, from the same fifteen grammars the
         * diff uses — `~/lib/highlight` is one registration and one palette, so
         * a TypeScript block in a reply and a TypeScript hunk in the Changes
         * panel cannot end up two different shades of blue.
         *
         * `detect: false`: colour only where the author named a language. Guessing
         * at an unlabelled block is a coin flip on three lines of pasted output,
         * and a wrong guess paints a log file as Perl. No fence info, no colour.
         */
        rehypePlugins={[[rehypeHighlight, { languages: GRAMMARS, detect: false }]]}
        components={{
          // Paragraph spacing is the transcript's, not markdown's: turns already
          // sit in a `gap`, and a leading margin here would double the first one.
          p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,

          code: ({ className: lang, children, ...props }) => {
            const fenced = /language-/.test(lang ?? "");
            if (!fenced) {
              return (
                <code
                  className="rounded-[5px] border border-border/70 bg-secondary px-1.5 py-0.5 font-mono text-[12.5px]"
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return (
              // Scrolls in its own box. A wide line in a transcript must not make
              // the column scroll sideways — the reader loses the conversation to
              // find the end of one command.
              <code className="block overflow-x-auto font-mono text-[12.5px] leading-relaxed" {...props}>
                {children}
              </code>
            );
          },

          // The block is drawn, not just tinted. `bg-panel` alone is a 0.02
          // lightness step off the transcript's ground, which reads as a shadow
          // rather than an edge — so where a fenced block starts and ends was a
          // guess. A border at full `--border` and a rounder corner make it an
          // object on the page, which is what a code block is.
          pre: ({ children }) => (
            <pre className="mb-3 overflow-x-auto rounded-[10px] border border-border bg-panel px-3.5 py-3 last:mb-0">
              {children}
            </pre>
          ),

          ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
          ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
          li: ({ children }) => <li className="pl-0.5">{children}</li>,

          // One rung down from body text. A model writing `##` in a chat reply
          // means "a heading within this answer", not "a page title".
          h1: ({ children }) => <h3 className="mb-2 mt-4 text-[14.5px] font-medium first:mt-0">{children}</h3>,
          h2: ({ children }) => <h3 className="mb-2 mt-4 text-[14.5px] font-medium first:mt-0">{children}</h3>,
          h3: ({ children }) => <h4 className="mb-2 mt-4 text-[14px] font-medium first:mt-0">{children}</h4>,

          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline-offset-4 hover:underline"
            >
              {children}
            </a>
          ),

          blockquote: ({ children }) => (
            <blockquote className="mb-3 border-l-2 border-border pl-3 text-muted-foreground last:mb-0">
              {children}
            </blockquote>
          ),

          table: ({ children }) => (
            <div className="mb-3 overflow-x-auto last:mb-0">
              <table className="w-full border-collapse text-[13px]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-border px-2 py-1 text-left font-medium">{children}</th>
          ),
          td: ({ children }) => <td className="border-b border-border px-2 py-1">{children}</td>,

          hr: () => <hr className="my-4 border-border" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
