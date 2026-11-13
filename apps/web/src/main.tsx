import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './styles.css';
import Dashboard from './pages/Dashboard';
import Transactions from './pages/Transactions';
import Portfolio from './pages/Portfolio';
import Settings from './pages/Settings';
import Year from './pages/Year';

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });

const NAV = [
  { to: '/', label: 'Painel' },
  { to: '/transacoes', label: 'Gastos' },
  { to: '/ano', label: 'Ano' },
  { to: '/carteira', label: 'Carteira' },
  { to: '/cadastros', label: 'Cadastros' },
];

function App() {
  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">My Wallet</span>
        <nav>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'}>
              {n.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="content">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/transacoes" element={<Transactions />} />
          <Route path="/ano" element={<Year />} />
          <Route path="/carteira/*" element={<Portfolio />} />
          <Route path="/cadastros" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
