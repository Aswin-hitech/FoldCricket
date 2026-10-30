import { useEffect, useState } from 'react'
import { isLaptopDevice } from '../utils/device'

/**
 * Reactive laptop/desktop check. Re-evaluates when the pointer profile changes
 * (e.g. a tablet attaching a mouse, or DevTools device emulation toggling).
 */
export function useLaptopDevice(): boolean {
  const [isLaptop, setIsLaptop] = useState(() => isLaptopDevice())

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return

    const queries = [
      window.matchMedia('(any-pointer: fine)'),
      window.matchMedia('(pointer: coarse)'),
      window.matchMedia('(hover: none)'),
    ]
    const update = () => setIsLaptop(isLaptopDevice())

    queries.forEach(q => {
      if (typeof q.addEventListener === 'function') q.addEventListener('change', update)
      else if (typeof q.addListener === 'function') q.addListener(update)
    })

    return () => {
      queries.forEach(q => {
        if (typeof q.removeEventListener === 'function') q.removeEventListener('change', update)
        else if (typeof q.removeListener === 'function') q.removeListener(update)
      })
    }
  }, [])

  return isLaptop
}
