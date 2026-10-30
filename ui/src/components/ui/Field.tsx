import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

const fieldStyle = 'field'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => <input ref={ref} className={cn(fieldStyle, 'input-field', className)} {...props} />)
Input.displayName = 'Input'

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => <textarea ref={ref} className={cn(fieldStyle, 'textarea-field', className)} {...props} />)
Textarea.displayName = 'Textarea'

export function FieldLabel({ htmlFor, children, className }: { htmlFor: string; children: React.ReactNode; className?: string }) {
  return <label htmlFor={htmlFor} className={cn('field-label', className)}>{children}</label>
}
