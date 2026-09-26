import { useRef, useState, type ReactNode } from 'react';
import { useOnClickOutside } from '../lib/hooks';

/** Button that opens a small popover menu. Items close it when clicked. */
export function Menu({
  trigger,
  children,
  align = 'right',
  placement = 'below',
  label,
}: {
  trigger: (props: { open: boolean; toggle: () => void; id: string }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  placement?: 'below' | 'above';
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOnClickOutside(ref, () => setOpen(false), open);
  const id = `menu-${label.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <div
      ref={ref}
      style={{ position: 'relative' }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false);
      }}
    >
      {trigger({ open, toggle: () => setOpen((o) => !o), id })}
      {open && (
        <div
          className="popover"
          id={id}
          role="menu"
          aria-label={label}
          style={{
            [align]: 0,
            ...(placement === 'below' ? { top: 'calc(100% + 6px)' } : { bottom: 'calc(100% + 6px)' }),
          }}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
