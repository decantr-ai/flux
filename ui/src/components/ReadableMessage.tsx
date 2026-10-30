import { HelpHint } from './ui/HelpHint'
import { Children, isValidElement, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Code2, Copy, ExternalLink, FileText, FolderOpen, Image as ImageIcon } from 'lucide-react'
import { classifyLink } from '../../../src/markdown.mjs'
import { Button } from './ui/Button'

type LocalLink = Extract<ReturnType<typeof classifyLink>, { kind: 'local' }>
interface FileInfo { name: string; path: string; exists: boolean; canReveal: boolean; previewUrl?: string | null; reason?: string; previewReason?: string }
interface MessageProps { text: string; sourceId: string; csrfToken: string; controls?: boolean }

function useFileInfo(sourceId: string, href: string) {
  const [info, setInfo] = useState<FileInfo | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setInfo(null)
    void fetch('/api/content-link?' + new URLSearchParams({ sourceId, href }), { signal: controller.signal, cache: 'no-store' })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error || 'File information is unavailable.'); return data as FileInfo })
      .then(setInfo)
      .catch(error => { if (error.name !== 'AbortError') setInfo({ name: 'File', path: classifyLink(href).kind === 'local' ? (classifyLink(href) as LocalLink).path : href, exists: false, canReveal: false, reason: error.message }) })
    return () => controller.abort()
  }, [sourceId, href])
  return info
}

function CopyAction({ value, label, compact = false }: { value: string; label: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState(false)
  async function copy() {
    try { await navigator.clipboard.writeText(value); setCopied(true); setError(false) }
    catch { setError(true) }
  }
  return <span className="message-copy"><button type="button" className="message-copy-button" onClick={() => void copy()} aria-label={copied ? 'Copied' : label} title={copied ? 'Copied' : label}>{copied ? <Check size={13} /> : <Copy size={13} />}{!compact && <span>{copied ? 'Copied' : label}</span>}</button>{error && <span className="message-link-notice" role="status">Copy unavailable; select the text in Source.</span>}</span>
}

function FileAction({ sourceId, link, info, csrfToken, children }: { sourceId: string; link: LocalLink; info: FileInfo | null; csrfToken: string; children: ReactNode }) {
  const [notice, setNotice] = useState('')
  async function reveal() {
    if (!info?.canReveal) { setNotice(info?.reason || 'Copy the path to open it on this device.'); return }
    try {
      const response = await fetch('/api/content-reveal', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Flux-CSRF': csrfToken }, body: JSON.stringify({ sourceId, href: link.href }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'The file could not be revealed.')
      setNotice('Revealed in Finder')
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : 'The file could not be revealed.') }
  }
  return <><span className="message-file-link">
    <button type="button" className="message-link" disabled={!info} onClick={() => void reveal()} title={(info?.canReveal ? 'Reveal in Finder: ' : '') + (info?.path || link.path) + (link.line ? ':' + link.line : '')}>{children}<FolderOpen size={13} aria-hidden="true" /></button>
    <CopyAction value={info?.path || link.path} label={'Copy path for ' + link.name} compact />
  </span>{notice && <span className="message-link-notice" role="status">{notice}</span>}</>
}
function FileLink({ sourceId, link, csrfToken, children }: { sourceId: string; link: LocalLink; csrfToken: string; children: ReactNode }) {
  const info = useFileInfo(sourceId, link.href)
  return <FileAction sourceId={sourceId} link={link} info={info} csrfToken={csrfToken}>{children}</FileAction>
}
export function ContentReference({ sourceId, href, csrfToken, children }: { sourceId: string; href: string; csrfToken: string; children?: ReactNode }) {
  const link = classifyLink(href)
  if (link.kind === 'web' || link.kind === 'email') return <a className="message-link" href={link.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" title={link.href}>{children || link.href}<ExternalLink size={13} aria-hidden="true" /></a>
  if (link.kind === 'local') return <FileLink sourceId={sourceId} link={link} csrfToken={csrfToken}>{children || link.name}</FileLink>
  return <span className="message-reference-text" title={href}>{children || href}</span>
}

function LocalImage({ sourceId, link, alt, csrfToken }: { sourceId: string; link: LocalLink; alt: string; csrfToken: string }) {
  const info = useFileInfo(sourceId, link.href)
  const [failed, setFailed] = useState(false)
  return <span className="message-image">
    {info?.previewUrl && !failed ? <a className="message-image-preview" href={info.previewUrl} target="_blank" rel="noopener noreferrer" aria-label={'Open image: ' + (alt || link.name)}><img src={info.previewUrl} alt={alt} loading="lazy" onError={() => setFailed(true)} /></a>
      : <span className="message-image-fallback"><ImageIcon size={21} /><span>{alt || link.name}</span><small>{!info ? 'Loading image…' : failed ? 'The image could not be displayed.' : info.reason || info.previewReason || 'Image preview unavailable.'}</small></span>}
    <span className="message-image-caption"><span>{alt || link.name}</span><span className="message-image-actions">{info?.previewUrl && !failed && <a className="message-link" href={info.previewUrl} target="_blank" rel="noopener noreferrer">Open image<ExternalLink size={12} /></a>}<FileAction sourceId={sourceId} link={link} info={info} csrfToken={csrfToken}>{info?.canReveal ? 'Show in Finder' : 'File location'}</FileAction></span></span>
  </span>
}
function MessageImage({ sourceId, src, alt, csrfToken }: { sourceId: string; src: string; alt: string; csrfToken: string }) {
  const link = classifyLink(src)
  if (link.kind === 'local') return <LocalImage key={src} sourceId={sourceId} link={link} alt={alt} csrfToken={csrfToken} />
  if (link.kind === 'web') return <span className="message-image message-remote-image"><span className="message-image-fallback"><ImageIcon size={21} /><span>{alt || 'Linked image'}</span><small>{link.host}</small><a className="message-link" href={link.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open image<ExternalLink size={13} /></a></span></span>
  return <span className="message-image-fallback"><ImageIcon size={20} /><span>{alt || 'Image'}</span><small>Unsupported image link. The original is available in Source.</small></span>
}
const nodeText = (value: ReactNode): string => Children.toArray(value).map(child => typeof child === 'string' || typeof child === 'number' ? String(child) : isValidElement<{ children?: ReactNode }>(child) ? nodeText(child.props.children) : '').join('')
function CodeBlock({ children }: { children: ReactNode }) {
  const code = Children.toArray(children).find(isValidElement)
  const language = isValidElement<{ className?: string }>(code) ? code.props.className?.replace('language-', '') : undefined
  return <div className="message-code"><div className="message-code-header"><span><Code2 size={13} />{language || 'Code'}</span><CopyAction value={nodeText(children).replace(/\n$/, '')} label="Copy code" /></div><pre tabIndex={0} aria-label="Code block">{children}</pre></div>
}

// Generated heading/footnote anchors are scoped to this one message, including
// aria-describedby references. Raw HTML is never parsed into this tree.
function scopedAnchors(prefix: string) {
  return () => (tree: { children?: unknown[] }) => {
    const visit = (node: { properties?: Record<string, unknown>; children?: unknown[] }) => {
      const props = node.properties
      if (props) {
        if (typeof props.id === 'string') props.id = prefix + props.id
        if (typeof props.href === 'string' && props.href.startsWith('#')) props.href = '#' + prefix + props.href.slice(1)
        if (typeof props.ariaDescribedBy === 'string') props.ariaDescribedBy = prefix + props.ariaDescribedBy
        if (Array.isArray(props.ariaDescribedBy)) props.ariaDescribedBy = props.ariaDescribedBy.map(id => prefix + id)
      }
      node.children?.forEach(child => visit(child as typeof node))
    }
    visit(tree)
  }
}

export default function ReadableMessage({ text, sourceId, csrfToken, controls = true }: MessageProps) {
  const [mode, setMode] = useState<'readable' | 'source'>('readable')
  const identity = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const plugins = useMemo(() => [scopedAnchors('flux-message-' + identity + '-')], [identity])
  return <section className="readable-message" aria-label="Message content">
    {controls && <div className="message-toolbar"><div className="help-inline"><div className="message-view-switch" role="group" aria-label="Message display"><Button size="small" variant={mode === 'readable' ? 'secondary' : 'ghost'} aria-pressed={mode === 'readable'} onClick={() => setMode('readable')}><FileText size={13} />Readable</Button><Button size="small" variant={mode === 'source' ? 'secondary' : 'ghost'} aria-pressed={mode === 'source'} onClick={() => setMode('source')}><Code2 size={13} />Source</Button></div><HelpHint topic="message-reader" /></div><CopyAction value={text} label="Copy original" /></div>}
    {mode === 'source' ? <pre className="message-original"><code>{text}</code></pre> : <div className="message-markdown"><Markdown remarkPlugins={[remarkGfm]} rehypePlugins={plugins} urlTransform={url => classifyLink(url).kind === 'blocked' ? '' : url} components={{
      h1: ({ node: _node, ...props }) => <h3 {...props} />,
      h2: ({ node: _node, ...props }) => <h3 {...props} />,
      h3: ({ node: _node, ...props }) => <h4 {...props} />,
      h4: ({ node: _node, ...props }) => <h5 {...props} />,
      pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
      table: ({ children }) => <div className="message-table-scroll" role="region" aria-label="Message table" tabIndex={0}><table>{children}</table></div>,
      a: ({ node: _node, href = '', children, ...props }) => {
        const link = classifyLink(href)
        if (link.kind === 'anchor') return <a {...props} className="message-anchor" href={link.href}>{children}</a>
        if (link.kind === 'blocked') return <span className="message-blocked-link" title="Unsupported link type">{children}</span>
        return <ContentReference sourceId={sourceId} href={href} csrfToken={csrfToken}>{children}</ContentReference>
      },
      img: ({ src = '', alt = '' }) => <MessageImage sourceId={sourceId} src={src} alt={alt} csrfToken={csrfToken} />,
    }}>{text}</Markdown></div>}
    {controls && <span className="message-original-note">Readable view only. Original text is preserved for evidence and model context.</span>}
  </section>
}
