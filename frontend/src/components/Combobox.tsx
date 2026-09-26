import { CaretDown, MagnifyingGlass, Plus } from '@phosphor-icons/react';
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useOnClickOutside } from '../lib/hooks';

export interface ComboOption {
  value: number;
  label: string;
  sub?: string;
  disabled?: boolean;
}

/**
 * Searchable single select following the ARIA combobox pattern. Optional
 * "create" row lets forms add a missing contact or product without leaving.
 */
export function Combobox({
  id,
  options,
  value,
  onChange,
  placeholder = 'Search',
  invalid,
  disabled,
  onCreate,
  createLabel = 'Create',
}: {
  id?: string;
  options: ComboOption[];
  value: number | null | undefined;
  onChange: (value: number | null) => void;
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
  onCreate?: (text: string) => void;
  createLabel?: string;
}) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const listId = `${inputId}-list`;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  useOnClickOutside(wrap, () => setOpen(false), open);

  const selected = options.find((o) => o.value === value);
  const filtered = useMemo(() => {
    const t = text.trim().toLowerCase();
    if (!t) return options.slice(0, 80);
    return options.filter((o) => `${o.label} ${o.sub ?? ''}`.toLowerCase().includes(t)).slice(0, 80);
  }, [options, text]);
  const canCreate = !!onCreate && text.trim().length > 0 && !options.some((o) => o.label.toLowerCase() === text.trim().toLowerCase());
  const total = filtered.length + (canCreate ? 1 : 0);

  const pick = (i: number) => {
    if (i < filtered.length) {
      const o = filtered[i]!;
      if (o.disabled) return;
      onChange(o.value);
    } else if (canCreate) {
      onCreate!(text.trim());
    }
    setText('');
    setOpen(false);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, total - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && total) {
        e.preventDefault();
        pick(active);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setText('');
    }
  };

  return (
    <div className="combo" ref={wrap}>
      <div className="input-icon">
        {open ? <MagnifyingGlass size={16} /> : <CaretDown size={14} style={{ left: 'auto', right: 12 }} />}
        <input
          id={inputId}
          className="input"
          style={open ? undefined : { paddingLeft: 12, paddingRight: 32 }}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-invalid={invalid || undefined}
          aria-activedescendant={open && total ? `${listId}-${active}` : undefined}
          autoComplete="off"
          disabled={disabled}
          placeholder={selected ? selected.label : placeholder}
          value={open ? text : selected ? selected.label + (selected.sub ? `  ${selected.sub}` : '') : ''}
          onFocus={() => {
            setOpen(true);
            setActive(0);
          }}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onKeyDown={onKey}
        />
      </div>
      {open && (
        <ul className="combo__list" id={listId} role="listbox">
          {filtered.map((o, i) => (
            <li
              key={o.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              aria-disabled={o.disabled || undefined}
              className="combo__opt"
              style={o.disabled ? { opacity: 0.45 } : undefined}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => pick(i)}
              onPointerEnter={() => setActive(i)}
            >
              <span>{o.label}</span>
              {o.sub && <span className="sub">{o.sub}</span>}
            </li>
          ))}
          {canCreate && (
            <li
              id={`${listId}-${filtered.length}`}
              role="option"
              aria-selected={active === filtered.length}
              className="combo__opt"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => pick(filtered.length)}
              onPointerEnter={() => setActive(filtered.length)}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Plus size={14} /> {createLabel} “{text.trim()}”
              </span>
            </li>
          )}
          {!total && <li className="combo__empty">Nothing matches.</li>}
        </ul>
      )}
    </div>
  );
}
