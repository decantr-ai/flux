import type { HTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/cn'

const badgeStyle = cva('badge', {
  variants: { variant: { neutral: 'badge-neutral', success: 'badge-success', warning: 'badge-warning', danger: 'badge-danger', rose: 'badge-rose' } },
  defaultVariants: { variant: 'neutral' },
})

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeStyle> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeStyle({ variant }), className)} {...props} />
}
