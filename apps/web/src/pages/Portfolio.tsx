import { NavLink, Route, Routes } from 'react-router';
import PositionsTab from './portfolio/PositionsTab';
import ChangesTab from './portfolio/ChangesTab';
import IncomeTab from './portfolio/IncomeTab';
import ImportTab from './portfolio/ImportTab';

export default function Portfolio() {
  return (
    <>
      <h1>Carteira</h1>
      <p className="subtitle">Posições a partir dos snapshots da corretora · proventos a partir do extrato</p>
      <nav className="tabs">
        <NavLink to="/carteira" end>
          Posições
        </NavLink>
        <NavLink to="/carteira/mudancas">Mudanças entre coletas</NavLink>
        <NavLink to="/carteira/proventos">Proventos</NavLink>
        <NavLink to="/carteira/importar">Importar</NavLink>
      </nav>
      <Routes>
        <Route index element={<PositionsTab />} />
        <Route path="mudancas" element={<ChangesTab />} />
        <Route path="proventos" element={<IncomeTab />} />
        <Route path="importar" element={<ImportTab />} />
      </Routes>
    </>
  );
}
