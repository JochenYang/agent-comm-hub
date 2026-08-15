import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** shadcn 标准 cn helper：合并 className 时尊重 Tailwind 优先级。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}