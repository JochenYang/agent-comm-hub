import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** shadcn standard cn helper: merges className respecting Tailwind precedence. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}