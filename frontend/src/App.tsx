import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, RouterProvider, useLocation, useRouteError, isRouteErrorResponse, Link } from 'react-router';
import { ForgotPage, LoginPage, ResetLinkPage, SignupPage, VerifyPage } from './auth/pages';
import { Logo } from './components/ui';
import { AppShell } from './layout/AppShell';
import { LiveProvider } from './lib/live';
import { useMe } from './lib/queries';
import type { OpType } from './lib/types';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const OperationsList = lazy(() => import('./pages/OperationsList'));
const OperationForm = lazy(() => import('./pages/OperationForm'));
const OperationPrint = lazy(() => import('./pages/OperationPrint'));
const Stock = lazy(() => import('./pages/Stock'));
const Products = lazy(() => import('./pages/Products'));
const ProductPage = lazy(() => import('./pages/ProductPage'));
const Categories = lazy(() => import('./pages/Categories'));
const Moves = lazy(() => import('./pages/Moves'));
const Warehouses = lazy(() => import('./pages/Warehouses'));
const Locations = lazy(() => import('./pages/Locations'));
const Contacts = lazy(() => import('./pages/Contacts'));
const Team = lazy(() => import('./pages/Team'));
const Profile = lazy(() => import('./pages/Profile'));

function Splash() {
  return (
    <div className="splash" role="status" aria-label="Loading">
      <Logo size={40} />
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { data: me, isLoading } = useMe();
  const location = useLocation();
  if (isLoading) return <Splash />;
  if (!me) {
    const next = location.pathname + location.search;
    return <Navigate to={next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return <LiveProvider enabled>{children}</LiveProvider>;
}

function GuestOnly({ children }: { children: ReactNode }) {
  const { data: me, isLoading } = useMe();
  if (isLoading) return <Splash />;
  if (me) return <Navigate to="/" replace />;
  return <>{children}</>;
}

const page = (el: ReactNode) => <Suspense fallback={<div className="page-loading" aria-busy="true" />}>{el}</Suspense>;

function RouteError() {
  const err = useRouteError();
  const notFound = isRouteErrorResponse(err) && err.status === 404;
  return (
    <div className="fatal">
      <Logo size={36} />
      <h1 className="page-title">{notFound ? 'Nothing on this shelf' : 'Something broke'}</h1>
      <p className="muted">{notFound ? 'That page does not exist.' : 'The page hit an unexpected error. Reloading usually fixes it.'}</p>
      <Link className="btn btn--primary" to="/">
        Back to dashboard
      </Link>
    </div>
  );
}

const opRoutes = (type: OpType, path: string) => [
  { path, element: page(<OperationsList type={type} />) },
  { path: `${path}/new`, element: page(<OperationForm type={type} />) },
  { path: `${path}/:id`, element: page(<OperationForm type={type} />) },
];

const router = createBrowserRouter(
  [
    { path: '/login', element: <GuestOnly><LoginPage /></GuestOnly> },
    { path: '/signup', element: <GuestOnly><SignupPage /></GuestOnly> },
    { path: '/forgot-password', element: <GuestOnly><ForgotPage /></GuestOnly> },
    // reachable signed in or out: links from emails land here
    { path: '/verify', element: <VerifyPage /> },
    { path: '/reset', element: <ResetLinkPage /> },
    {
      path: '/print/:id',
      element: <RequireAuth>{page(<OperationPrint />)}</RequireAuth>,
    },
    {
      path: '/',
      element: (
        <RequireAuth>
          <AppShell />
        </RequireAuth>
      ),
      errorElement: <RouteError />,
      children: [
        { index: true, element: page(<Dashboard />) },
        ...opRoutes('receipt', 'receipts'),
        ...opRoutes('delivery', 'deliveries'),
        ...opRoutes('internal', 'transfers'),
        ...opRoutes('adjustment', 'adjustments'),
        { path: 'stock', element: page(<Stock />) },
        { path: 'products', element: page(<Products />) },
        { path: 'products/new', element: page(<ProductPage />) },
        { path: 'products/:id', element: page(<ProductPage />) },
        { path: 'categories', element: page(<Categories />) },
        { path: 'moves', element: page(<Moves />) },
        { path: 'settings/warehouses', element: page(<Warehouses />) },
        { path: 'settings/locations', element: page(<Locations />) },
        { path: 'contacts', element: page(<Contacts />) },
        { path: 'team', element: page(<Team />) },
        { path: 'profile', element: page(<Profile />) },
        { path: '*', element: <RouteError /> },
      ],
    },
  ],
  { basename: '/app' },
);

export function App() {
  return <RouterProvider router={router} />;
}
