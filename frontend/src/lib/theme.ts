import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';
const mq = () => window.matchMedia('(prefers-color-scheme: dark)');

export function currentTheme(): Theme {
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'light' || t === 'dark') return t;
  return mq().matches ? 'dark' : 'light';
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  useEffect(() => {
    const m = mq();
    const on = () => setTheme(currentTheme());
    m.addEventListener('change', on);
    window.addEventListener('ss:theme', on);
    return () => {
      m.removeEventListener('change', on);
      window.removeEventListener('ss:theme', on);
    };
  }, []);
  useEffect(() => {
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0c0e0f' : '#eef0f1');
  }, [theme]);
  const toggle = () => {
    const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('ss-theme', next);
    } catch {
      /* storage can be unavailable */
    }
    window.dispatchEvent(new Event('ss:theme'));
  };
  return [theme, toggle];
}
