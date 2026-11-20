import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

/**
 * An assistant reply, with light markdown: bold, italics, line breaks, lists and links.
 *
 * The text comes from a model, so it is untrusted:
 * - raw HTML is dropped (skipHtml), never rendered: "<script>" can't run;
 * - only the elements below are allowed; anything else (headings, tables, images, code
 *   blocks) is unwrapped to its plain text, or dropped if it has none (an image);
 * - links must be http(s), mailto, tel or a page on this site; anything else (javascript:,
 *   data:) is shown as plain text. Links open in a new tab, without access to this page.
 */
const ALLOWED = ['p', 'br', 'strong', 'em', 'del', 'ul', 'ol', 'li', 'a', 'code'];
const SAFE_LINK = /^(https?:|mailto:|tel:|\/(?!\/))/i;

const components: Components = {
  p: ({ children }) => <p className="leading-relaxed">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  ul: ({ children }) => <ul className="list-disc space-y-1.5 pl-6 leading-relaxed marker:text-ink-muted">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal space-y-1.5 pl-6 leading-relaxed marker:text-ink-muted">{children}</ol>,
  li: ({ children }) => <li className="pl-1">{children}</li>,
  code: ({ children }) => <code className="rounded bg-slate-100 px-1 py-0.5">{children}</code>,
  a: ({ href, children }) =>
    href && SAFE_LINK.test(href) ? (
      <a href={href} target="_blank" rel="noopener noreferrer" className="font-medium text-accent underline underline-offset-2">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
};

export function AssistantText({ text }: { text: string }) {
  return (
    <div className="max-w-full space-y-3 text-ink">
      <Markdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        skipHtml
        allowedElements={ALLOWED}
        unwrapDisallowed
        urlTransform={defaultUrlTransform}
        components={components}
      >
        {text}
      </Markdown>
    </div>
  );
}
