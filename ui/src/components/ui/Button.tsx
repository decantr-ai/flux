import type { ButtonHTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/cn'

const buttonStyle = cva(
  'button',
  {
    variants: {
      variant: {
        primary: 'button-primary',
        secondary: 'button-secondary',
        quiet: 'button-quiet',
        ghost: 'button-ghost',
        destructive: 'button-destructive',
      },
      size: { default: '', small: 'button-small', icon: 'button-icon' },
    },
    defaultVariants: { variant: 'secondary', size: 'default' },
  },
)

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonStyle> {}

export function Button({ className, variant, size, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={cn(buttonStyle({ variant, size }), className)} {...props} />
}
