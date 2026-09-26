import { Moon, Sun } from '@phosphor-icons/react';
import { useReducedMotion } from 'motion/react';
import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Logo } from '../components/ui';
import { currentTheme, useTheme } from '../lib/theme';

export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const reduce = useReducedMotion();
  const [theme, toggle] = useTheme();

  useEffect(() => {
    let disposed = false;
    let dispose: (() => void) | undefined;
    const c = canvas.current;
    if (!c) return;
    // three.js is its own chunk; the form is usable before it arrives
    import('./scene')
      .then(({ mountAuthScene }) => {
        if (disposed) return;
        try {
          const s = mountAuthScene(c, { reduceMotion: !!reduce, theme: currentTheme });
          dispose = s.dispose;
        } catch {
          c.style.display = 'none';
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      dispose?.();
    };
  }, [reduce]);

  return (
    <div className="auth">
      <section className="auth__panel">
        <header className="auth__top">
          <a className="brand" href="/" aria-label="StockSense home">
            <Logo size={26} />
            <span>StockSense</span>
          </a>
          <button type="button" className="btn btn--quiet btn--icon btn--sm" onClick={toggle} aria-label="Switch theme">
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </header>
        <div className="auth__form">
          <h1 className="auth__title">{title}</h1>
          <p className="auth__sub">{subtitle}</p>
          {children}
        </div>
        {footer && <footer className="auth__foot">{footer}</footer>}
      </section>
      <aside className="auth__stage" aria-hidden="true">
        <canvas ref={canvas} />
        <div className="auth__float f1">
          <b>WH/IN/0042</b>
          <span>Steel rod</span>
          <em className="c-in">+50 kg</em>
        </div>
        <div className="auth__float f2">
          <b>WH/OUT/0112</b>
          <span>Office chair</span>
          <em className="c-out">−10 u</em>
        </div>
        <div className="auth__float f3">
          <b>WH/Stock1</b>
          <span>Main store</span>
        </div>
        <p className="auth__line">
          Receipts, deliveries, transfers and counts across every warehouse, <b>in one ledger.</b>
        </p>
      </aside>
    </div>
  );
}

export const AuthSwitch = ({ children, to, label }: { children: ReactNode; to: string; label: string }) => (
  <p className="auth__switch">
    {children} <Link to={to}>{label}</Link>
  </p>
);
