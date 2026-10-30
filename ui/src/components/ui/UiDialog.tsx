import { Dialog } from '@base-ui/react/dialog'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from './Button'

export function UiDialog({ open, onOpenChange, title, description, children, actions, width = 'max-w-xl' }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children: ReactNode
  actions?: ReactNode
  width?: string
}) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Backdrop className="dialog-backdrop" />
      <Dialog.Viewport className="fixed inset-0 z-[101] grid place-items-center overflow-y-auto p-3 sm:p-6">
        <Dialog.Popup className={`ui-dialog relative my-auto max-h-[calc(100dvh-24px)] w-full ${width} overflow-y-auto sm:max-h-[calc(100dvh-48px)]`}>
          <div className="dialog-head mb-4">
            <div><Dialog.Title className="question-title">{title}</Dialog.Title>{description && <Dialog.Description className="question-description">{description}</Dialog.Description>}</div>
            <Dialog.Close render={<Button aria-label="Close dialog" variant="ghost" size="icon" className="-mr-2 -mt-2" />}><X size={18} /></Dialog.Close>
          </div>
          {children}
          {actions && <div className="mt-6 flex flex-wrap justify-end gap-2.5 border-t border-line pt-5">{actions}</div>}
        </Dialog.Popup>
      </Dialog.Viewport>
    </Dialog.Portal>
  </Dialog.Root>
}
