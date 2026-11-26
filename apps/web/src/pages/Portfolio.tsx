import { NavLink, Route, Routes } from 'react-router';
import PositionsTab from './portfolio/PositionsTab';
import ChangesTab from './portfolio/ChangesTab';
import IncomeTab from './portfolio/IncomeTab';
import TradesTab from './portfolio/TradesTab';
import ImportTab from './portfolio/ImportTab';
import ThesesTab from './portfolio/ThesesTab';
import ThesisPage from './portfolio/ThesisPage';
import CorrelationPage from './portfolio/CorrelationPage';
import MapPage from './portfolio/MapPage';
import PolicyTab from './portfolio/PolicyTab';
import PerformanceTab from './portfolio/PerformanceTab';
import HypotheticalsTab from './portfolio/HypotheticalsTab';

export default function Portfolio() {
  return (
    <>
      <h1>Carteira</h1>
      <p className="subtitle">Posições a partir dos snapshots da corretora · proventos a partir do extrato</p>
      <nav className="tabs">
        <NavLink to="/carteira" end>
          Posições
        </NavLink>
        <NavLink to="/carteira/teses">Teses</NavLink>
        <NavLink to="/carteira/politica">Política</NavLink>
        <NavLink to="/carteira/desempenho">Desempenho</NavLink>
        <NavLink to="/carteira/hipoteticas">Hipotéticas</NavLink>
        <NavLink to="/carteira/mudancas">Mudanças entre coletas</NavLink>
        <NavLink to="/carteira/proventos">Proventos</NavLink>
        <NavLink to="/carteira/operacoes">Operações</NavLink>
        <NavLink to="/carteira/importar">Importar</NavLink>
      </nav>
      <Routes>
        <Route index element={<PositionsTab />} />
        <Route path="teses" element={<ThesesTab />} />
        <Route path="teses/mapa" element={<MapPage />} />
        <Route path="teses/correlacao" element={<CorrelationPage />} />
        <Route path="teses/:id" element={<ThesisPage />} />
        <Route path="politica" element={<PolicyTab />} />
        <Route path="desempenho" element={<PerformanceTab />} />
        <Route path="hipoteticas" element={<HypotheticalsTab />} />
        <Route path="mudancas" element={<ChangesTab />} />
        <Route path="proventos" element={<IncomeTab />} />
        <Route path="operacoes" element={<TradesTab />} />
        <Route path="importar" element={<ImportTab />} />
      </Routes>
    </>
  );
}
