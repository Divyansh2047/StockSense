import { CheckCircle, Info, WarningCircle, X } from '@phosphor-icons/react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

type Tone = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  tone: Tone;
  title: string;
  body?: string;
}
interface ToastApi {
  show: (tone: Tone, title: string, body?: string) => void;
  success: (title: string, body?: string) => void;
  error: (title: string, body?: string) => void;
  info: (title: string, body?: string) => void;
}
const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(0);
  const reduce = useReducedMotion();
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((t) => t.id !== id)), []);
  const show = useCallback(
    (tone: Tone, title: string, body?: string) => {
      const id = ++seq.current;
      setItems((xs) => [...xs.slice(-3), { id, tone, title, body }]);
      window.setTimeout(() => dismiss(id), tone === 'error' ? 7000 : 4200);
    },
    [dismiss],
  );
  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (t, b) => show('success', t, b),
      error: (t, b) => show('error', t, b),
      info: (t, b) => show('info', t, b),
    }),
    [show],
  );
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        <AnimatePresence initial={false}>
          {items.map((t) => (
            <motion.div
              key={t.id}
              className="toast"
              data-tone={t.tone}
              layout={!reduce}
              initial={reduce ? false : { opacity: 0, y: 16, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, x: 40 }}
              transition={{ type: 'spring', stiffness: 380, damping: 32 }}
            >
              <span className="toast__icon">
                {t.tone === 'success' ? <CheckCircle size={20} weight="fill" /> : t.tone === 'error' ? <WarningCircle size={20} weight="fill" /> : <Info size={20} weight="fill" />}
              </span>
              <div>
                <b>{t.title}</b>
                {t.body && <p>{t.body}</p>}
              </div>
              <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss">
                <X size={16} />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useToast outside ToastProvider');
  return ctx;
}
