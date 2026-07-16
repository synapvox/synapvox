import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';

const normalizeMathDelimiters = (text: string) => text
  .replace(/\\\[([\s\S]*?)\\\]/g, (_match, expression: string) => `\n$$\n${expression.trim()}\n$$\n`)
  .replace(/\\\(([\s\S]*?)\\\)/g, (_match, expression: string) => `$${expression.trim()}$`);

const MarkdownMessage = ({ text }: { text: string }) => (
  <div className="chat-markdown">
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        a: ({ children, ...props }) => (
          <a {...props} target="_blank" rel="noreferrer">{children}</a>
        ),
      }}
    >
      {normalizeMathDelimiters(text)}
    </ReactMarkdown>
  </div>
);

export default MarkdownMessage;
