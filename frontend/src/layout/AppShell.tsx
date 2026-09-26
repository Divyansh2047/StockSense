import {
  ArrowDownLeft,
  ArrowUpRight,
  ArrowsLeftRight,
  AddressBook,
  CaretUpDown,
  ClockCounterClockwise,
  Cube,
  Gauge,
  List,
  MagnifyingGlass,
  MapPin,
  Moon,
  Package,
  Scales,
  SignOut,
  Stack,
  Sun,
  Tag,
  UserCircle,
  UsersThree,
  Warehouse,
  X,
} from '@phosphor-icons/react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { post } from '../lib/api';
import { initials } from '../lib/format';
import { useLive } from '../lib/live';
import { queryClient, useDashboard, useMe } from '../lib/queries';
import { useTheme } from '../lib/theme';
import { Logo } from '../components/ui';
import { Menu } from '../components/Menu';
import { CommandPalette } from './CommandPalette';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  count?: number;
  alert?: boolean;
}

function useNav(): { title?: string; items: NavItem[] }[] {
  const { data } = useDashboard({});
  const c = data?.cards;
  return [
    { items: [{ to: '/', label: 'Dashboard', icon: <Gauge size={19} /> }] },
    {
      title: 'Operations',
      items: [
        { to: '/receipts', label: 'Receipts', icon: <ArrowDownLeft size={19} />, count: c?.receipt.pending },
        {
          to: '/deliveries',
          label: 'Deliveries',
          icon: <ArrowUpRight size={19} />,
          count: c?.delivery.pending,
          alert: (c?.delivery.waiting ?? 0) > 0,
        },
        { to: '/transfers', label: 'Transfers', icon: <ArrowsLeftRight size={19} />, count: c?.internal.pending },
        { to: '/adjustments', label: 'Adjustments', icon: <Scales size={19} />, count: c?.adjustment.pending },
      ],
    },
    {
      title: 'Inventory',
      items: [
        {
          to: '/stock',
          label: 'Stock',
          icon: <Stack size={19} />,
          count: data ? data.kpis.lowStock + data.kpis.outOfStock : undefined,
          alert: (data?.kpis.outOfStock ?? 0) > 0,
        },
        { to: '/products', label: 'Products', icon: <Package size={19} /> },
        { to: '/categories', label: 'Categories', icon: <Tag size={19} /> },
        { to: '/moves', label: 'Move history', icon: <ClockCounterClockwise size={19} /> },
      ],
    },
    {
      title: 'Settings',
      items: [
        { to: '/settings/warehouses', label: 'Warehouses', icon: <Warehouse size={19} /> },
        { to: '/settings/locations', label: 'Locations', icon: <MapPin size={19} /> },
        { to: '/contacts', label: 'Contacts', icon: <AddressBook size={19} /> },
        { to: '/team', label: 'Team', icon: <UsersThree size={19} /> },
      ],
    },
  ];
}

async function logout() {
  await post('/auth/logout').catch(() => undefined);
  queryClient.clear();
  queryClient.setQueryData(['me'], null);
}

function ProfileMenu({ placement }: { placement: 'above' | 'below' }) {
  const { data: me } = useMe();
  const navigate = useNavigate();
  if (!me) return null;
  return (
    <Menu
      label="Profile menu"
      placement={placement}
      align="left"
      trigger={({ open, toggle, id }) => (
        <button type="button" className="profile-btn" onClick={toggle} aria-expanded={open} aria-controls={id} aria-haspopup="menu">
          <span className="avatar" aria-hidden="true">
            {initials(me.name)}
          </span>
          <span className="profile-btn__text">
            <b>{me.name}</b>
            <span>{me.role === 'manager' ? 'Inventory manager' : 'Warehouse staff'}</span>
          </span>
          <CaretUpDown size={16} aria-hidden="true" />
        </button>
      )}
    >
      {(close) => (
        <>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              close();
              navigate('/profile');
            }}
          >
            <UserCircle size={18} /> My profile
          </button>
          <div className="menu-sep" />
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={async () => {
              close();
              await logout();
              navigate('/login', { replace: true });
            }}
          >
            <SignOut size={18} /> Log out
          </button>
        </>
      )}
    </Menu>
  );
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const groups = useNav();
  return (
    <nav className="side-nav" aria-label="Main">
      {groups.map((g, gi) => (
        <div className="side-nav__group" key={gi}>
          {g.title && <div className="side-nav__title">{g.title}</div>}
          {g.items.map((it) => (
            <NavLink key={it.to} to={it.to} end={it.to === '/'} className="side-link" onClick={onNavigate}>
              {it.icon}
              <span>{it.label}</span>
              {!!it.count && (
                <span className={`badge ${it.alert ? 'badge--out' : ''}`} aria-label={`${it.count} open`}>
                  {it.count}
                </span>
              )}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );
}

function LivePill() {
  const { state, pulse } = useLive();
  const reduce = useReducedMotion();
  const label = state === 'live' ? 'Live' : state === 'connecting' ? 'Connecting' : 'Offline';
  return (
    <span className="live-pill" data-state={state} title={state === 'live' ? 'Changes from other users appear instantly' : 'Reconnecting to live updates'}>
      <span className="live-dot" key={reduce ? 0 : pulse} />
      {label}
    </span>
  );
}

const TITLES: [RegExp, string][] = [
  [/^\/$/, 'Dashboard'],
  [/^\/receipts/, 'Receipts'],
  [/^\/deliveries/, 'Deliveries'],
  [/^\/transfers/, 'Transfers'],
  [/^\/adjustments/, 'Adjustments'],
  [/^\/stock/, 'Stock'],
  [/^\/products/, 'Products'],
  [/^\/categories/, 'Categories'],
  [/^\/moves/, 'Move history'],
  [/^\/settings\/warehouses/, 'Warehouses'],
  [/^\/settings\/locations/, 'Locations'],
  [/^\/contacts/, 'Contacts'],
  [/^\/team/, 'Team'],
  [/^\/profile/, 'My profile'],
];

export function AppShell() {
  const [theme, toggleTheme] = useTheme();
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const location = useLocation();
  const reduce = useReducedMotion();
  const section = TITLES.find(([re]) => re.test(location.pathname))?.[1] ?? '';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) {
        e.preventDefault();
        setPalette(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => setDrawer(false), [location.pathname]);

  return (
    <div className="shell">
      <a href="#content" className="skip-link">
        Skip to content
      </a>

      <aside className="sidebar">
        <NavLinkBrand />
        <SidebarNav />
        <div className="sidebar__foot">
          <ProfileMenu placement="above" />
        </div>
      </aside>

      <AnimatePresence>
        {drawer && (
          <>
            <motion.div className="drawer-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setDrawer(false)} />
            <motion.aside
              className="drawer"
              aria-label="Navigation"
              initial={reduce ? { opacity: 0 } : { x: '-100%' }}
              animate={reduce ? { opacity: 1 } : { x: 0 }}
              exit={reduce ? { opacity: 0 } : { x: '-100%' }}
              transition={{ type: 'spring', stiffness: 380, damping: 38 }}
            >
              <div className="drawer__head">
                <NavLinkBrand />
                <button type="button" className="btn btn--quiet btn--icon btn--sm" onClick={() => setDrawer(false)} aria-label="Close menu">
                  <X size={18} />
                </button>
              </div>
              <SidebarNav onNavigate={() => setDrawer(false)} />
              <div className="sidebar__foot">
                <ProfileMenu placement="above" />
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <div className="main">
        <header className="topbar">
          <button type="button" className="btn btn--quiet btn--icon topbar__menu" onClick={() => setDrawer(true)} aria-label="Open menu">
            <List size={20} />
          </button>
          <div className="topbar__section">{section}</div>
          <button type="button" className="search-trigger" onClick={() => setPalette(true)}>
            <MagnifyingGlass size={16} aria-hidden="true" />
            <span>Search SKU, reference, page</span>
            <kbd>⌘K</kbd>
          </button>
          <div className="topbar__right">
            <LivePill />
            <button type="button" className="btn btn--quiet btn--icon" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
              {theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}
            </button>
            <div className="topbar__profile">
              <ProfileMenu placement="below" />
            </div>
          </div>
        </header>

        <main id="content" className="content" tabIndex={-1}>
          <motion.div
            key={location.pathname}
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          >
            <Outlet />
          </motion.div>
        </main>
      </div>

      <nav className="tabbar" aria-label="Quick navigation">
        <NavLink to="/" end className="tab">
          <Gauge size={22} />
          <span>Home</span>
        </NavLink>
        <NavLink to="/receipts" className="tab">
          <ArrowDownLeft size={22} />
          <span>Receive</span>
        </NavLink>
        <NavLink to="/deliveries" className="tab">
          <ArrowUpRight size={22} />
          <span>Deliver</span>
        </NavLink>
        <NavLink to="/stock" className="tab">
          <Cube size={22} />
          <span>Stock</span>
        </NavLink>
        <button type="button" className="tab" onClick={() => setDrawer(true)}>
          <List size={22} />
          <span>More</span>
        </button>
      </nav>

      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}

function NavLinkBrand() {
  return (
    <NavLink to="/" className="brand" aria-label="StockSense dashboard">
      <Logo size={26} />
      <span>StockSense</span>
    </NavLink>
  );
}
