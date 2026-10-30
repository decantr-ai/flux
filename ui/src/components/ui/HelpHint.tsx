import { Popover } from '@base-ui/react/popover'
import { CircleHelp, X } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { HELP_TOPICS, type HelpTopicId } from '../../lib/help-topics'

export function HelpHint({ topic, className }: { topic: HelpTopicId; className?: string }) {
  const [open, setOpen] = useState(false)
  const triggerId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const dismissed = useRef(false)
  const help = HELP_TOPICS[topic]
  return <Popover.Root open={open} triggerId={triggerId} onOpenChange={(next, details) => {
    const focused = document.activeElement
    const keyboardFocus = triggerRef.current === focused && triggerRef.current?.matches(':focus-visible')
    const popupFocus = focused instanceof Node && popupRef.current?.contains(focused)
    if (details.reason === 'trigger-hover' && ((!next && (keyboardFocus || popupFocus)) || (next && dismissed.current && keyboardFocus))) return
    if (!next && ['escape-key', 'close-press'].includes(details.reason)) dismissed.current = true
    setOpen(next)
  }} modal={false}>
    <Popover.Trigger id={triggerId} ref={triggerRef} className={['help-hint-trigger', className].filter(Boolean).join(' ')} aria-label={`Help: ${help.title}`} data-help-topic={topic} openOnHover delay={250} closeDelay={150} onFocus={event => { if (!dismissed.current && event.currentTarget.matches(':focus-visible')) setOpen(true) }} onBlur={() => { dismissed.current = false }}>
      <CircleHelp size={15} aria-hidden="true" />
    </Popover.Trigger>
    <Popover.Portal><Popover.Positioner className="help-hint-positioner" sideOffset={6} collisionPadding={12}>
      <Popover.Popup ref={popupRef} className="help-hint-popup" initialFocus={false}>
        <div className="help-hint-header"><Popover.Title className="help-hint-title">{help.title}</Popover.Title><Popover.Close className="help-hint-close" aria-label="Close help"><X size={14} aria-hidden="true" /></Popover.Close></div>
        <Popover.Description className="help-hint-body">{help.body}</Popover.Description>
      </Popover.Popup>
    </Popover.Positioner></Popover.Portal>
  </Popover.Root>
}
